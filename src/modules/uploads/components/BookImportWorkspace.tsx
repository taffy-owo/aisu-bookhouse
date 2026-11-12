import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type SetStateAction } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ROUTES } from '../../../config/routes';
import { useSession } from '../../../app/SessionContext';
import { getAccountScope, subscribeBeforeAccountChange } from '../../../shared/api';
import { BookOpenText, ChevronDown, FileUp, Link2, LoaderCircle, PenLine, Send, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '../../../shared/components/Button';
import { Panel } from '../../../shared/components/Panel';
import { SectionHeader } from '../../library/components/SectionHeader';
import { invalidateBookListCache } from '../../books';
import { getAiModelSettings } from '../../settings/services/aiModelSettingsService';
import { getTranslationModelOptions, type TranslationModelOption } from '../../settings/services/aiChannelService';
import { UploadDropzone } from './UploadDropzone';
import { ManualDraftStorageStatus } from './ManualDraftStorageStatus';
import { TaskListReadStatus, type TaskListReadState } from './TaskListReadStatus';
import { UploadTaskList } from './UploadTaskList';
import { TranslationSubmissionList } from './TranslationSubmissionList';
import { useTranslationSubmissions } from '../hooks/useTranslationSubmissions';
import { useTaskFocus } from '../hooks/useTaskFocus';
import { TranslationTaskList } from './TranslationTaskList';
import { clearManualBookDraft, EMPTY_MANUAL_BOOK_DRAFT, mergeRecoveredManualBookDraft, prepareManualBook, readManualBookDraftState, reserveManualBookSubmission, retryManualBookDraftStorage, updateManualBookDraft, writeManualBookDraft, type ManualBookDraft, type ManualBookDraftStorageIssue } from '../services/manualBookDraft';
import { createUploadAttempt, type UploadAttempt } from '../services/uploadAttempt';
import { createRequestId } from '../../../shared/utils/requestId';
import { manualSourceMetadataMessage, mergeManualSourceMetadata } from '../services/manualSourceMetadata';
import { getWorkSourceMetadata, looksLikeSupportedSourceLink, type WorkSourceMetadata } from '../services/sourceMetadataService';
import {
  createTranslationLookupState,
  isLatestTranslationLookup,
  shouldRequestTranslationLookup,
} from '../services/translationLookupState';
import { UPLOAD_TASKS_CHANGED_EVENT, clearCompletedUploadTasks, createAcceptedUploadTask, createQueuedUploadTasks, getUploadTasks, reprocessUploadedBook, uploadBookFiles, type UploadBookMetadata } from '../services/uploadService';
import { adoptUploadTask } from '../services/uploadTaskState';
import { TRANSLATION_JOBS_CHANGED_EVENT, clearCompletedWholeBookTranslations, deleteWholeBookTranslation, getWholeBookTranslationJobs, pauseWholeBookTranslation, resumeWholeBookTranslation, retryWholeBookTranslation, updateWholeBookTranslationConcurrency, updateWholeBookTranslationModel, type WholeBookTranslationJob } from '../services/wholeBookTranslationService';
import type { UploadTask } from '../types/upload';
import { startPolling } from '../../../shared/utils/polling';

const INITIAL_TASK_LIST_READ_STATE: TaskListReadState = { hasLoaded: false, isLoading: true, error: '' };
const UPLOAD_BUSY_MESSAGE = '请等待当前上传完成后，再重试或重新选择文件。';
const UPLOAD_TASK_REFRESH_INTERVAL_MS = 900;
const PROCESSING_PROGRESS_INTERVAL_MS = 120;
const PROCESSING_PROGRESS_LIMIT = 96;
const PROCESSING_PROGRESS_STEP = 0.35;
export function BookImportWorkspace({ view }: { view: 'upload' | 'translation' }) {
  const isTranslationView = view === 'translation';
  const [searchParams] = useSearchParams();
  const focusedTaskId = searchParams.get('task');
  const locatedTaskRef = useRef<string | null>(null);
  const FormContainer = isTranslationView ? 'details' : Panel;
  const { session } = useSession();
  const { taskPanelRef, rememberTaskFocus } = useTaskFocus(getAccountScope());
  const [initialManualDraft] = useState(() => {
    const stored = readManualBookDraftState();
    return {
      draft: stored.draft ?? EMPTY_MANUAL_BOOK_DRAFT,
      restored: Boolean(stored.draft?.content.trim()),
      issue: stored.issue,
    };
  });
  const [errorMessage, setErrorMessage] = useState('');
  const [isLookingUpSource, setIsLookingUpSource] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isClearingTasks, setIsClearingTasks] = useState(false);
  const [manualDraft, setManualDraft] = useState<ManualBookDraft>(initialManualDraft.draft);
  const [hasRestoredManualDraft, setHasRestoredManualDraft] = useState(initialManualDraft.restored);
  const [manualDraftStorageIssue, setManualDraftStorageIssue] = useState<ManualBookDraftStorageIssue>(initialManualDraft.issue);
  const [manualSuccessMessage, setManualSuccessMessage] = useState('');
  const [sourceLookupError, setSourceLookupError] = useState('');
  const [sourceLookupMessage, setSourceLookupMessage] = useState('');
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [uploadTaskReadState, setUploadTaskReadState] = useState(INITIAL_TASK_LIST_READ_STATE);
  const [translationTaskReadState, setTranslationTaskReadState] = useState(INITIAL_TASK_LIST_READ_STATE);
  const [translationError, setTranslationError] = useState('');
  const [translationJobs, setTranslationJobs] = useState<WholeBookTranslationJob[]>([]);
  const [translationActionJobIds, setTranslationActionJobIds] = useState<ReadonlySet<string>>(new Set());
  const [translationActionErrors, setTranslationActionErrors] = useState<Record<string, string>>({});
  const [translationPreview, setTranslationPreview] = useState<WorkSourceMetadata | null>(null);
  const [translationPreferencesOpen, setTranslationPreferencesOpen] = useState(false);
  const [translationPrompt, setTranslationPrompt] = useState('');
  const [preferredTranslationConcurrency, setTranslationConcurrency] = useState(2);
  const [translationModel, setTranslationModel] = useState('');
  const [translationModelOptions, setTranslationModelOptions] = useState<TranslationModelOption[]>([]);
  const [translationUrl, setTranslationUrl] = useState('');
  const [isLoadingTranslationDefaults, setIsLoadingTranslationDefaults] = useState(true);
  const [isLoadingTranslationModels, setIsLoadingTranslationModels] = useState(true);
  const [translationDefaultsError, setTranslationDefaultsError] = useState('');
  const [translationModelsError, setTranslationModelsError] = useState('');
  const [translationConfigurationReloadKey, setTranslationConfigurationReloadKey] = useState(0);
  const translationPreferencesEditedRef = useRef({ prompt: false, concurrency: false });
  const [isLookingUpTranslation, setIsLookingUpTranslation] = useState(false);
  const [uploadMode, setUploadMode] = useState<'file' | 'manual' | 'translation'>(isTranslationView ? 'translation' : 'file');
  const isMountedRef = useRef(true);
  const uploadEpochRef = useRef(0);
  const manualDraftOwnerRef = useRef<string | null>(session?.id ?? null);
  const pendingManualDraftRef = useRef<{ draft: ManualBookDraft; ownerId: string | null; scope: string } | null>(null);
  const savedManualDraftRef = useRef(initialManualDraft.draft);
  const translationLookupRef = useRef(createTranslationLookupState());
  const sourceLookupControllerRef = useRef<AbortController | null>(null);
  const isUploadingRef = useRef(false);
  const refreshPollingStopRef = useRef<(() => void) | null>(null);
  const processingProgressStopsRef = useRef(new Map<string, () => void>());
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const uploadAttemptsRef = useRef(new Map<string, UploadAttempt>());
  const reprocessRequestIdsRef = useRef(new Map<string, string>());
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const taskAwaitingReselectRef = useRef<string | null>(null);
  const serverTaskIdsRef = useRef(new Map<string, string>());
  const knownTaskStatusRef = useRef<Map<string, UploadTask['status']> | null>(null);
  const clearTasksControllerRef = useRef<AbortController | null>(null);
  const translationActionControllersRef = useRef(new Set<AbortController>());
  const translationJobActionControllersRef = useRef(new Map<string, AbortController>());
  const translationJobsRevisionRef = useRef(0);
  const taskClearRevisionRef = useRef(0);
  const uploadReceiptRevisionRef = useRef(0);
  const uploadTaskReadTokenRef = useRef<symbol | null>(null);
  const initialUploadTaskReadControllerRef = useRef<AbortController | null>(null);
  const translationTaskReadSignalRef = useRef<AbortSignal | null>(null);

  const handleTranslationCreated = useCallback((job: WholeBookTranslationJob) => {
    translationJobsRevisionRef.current += 1;
    setTranslationJobs((jobs) => [job, ...jobs.filter((item) => item.id !== job.id)]);
  }, []);
  const { submissions: translationSubmissions, storageWarning: translationSubmissionWarning, queue: translationSubmissionQueue } = useTranslationSubmissions(JSON.stringify(session?.id ?? null), handleTranslationCreated);
  const queueingTranslationCount = translationSubmissions.filter((item) => item.status === 'pending').length;

  const flushManualDraft = useCallback((notify = true) => {
    const pending = pendingManualDraftRef.current;
    if (!pending || manualDraftOwnerRef.current !== pending.ownerId || getAccountScope() !== pending.scope) return;
    const succeeded = writeManualBookDraft(pending.draft);
    if (succeeded) {
      pendingManualDraftRef.current = null;
      savedManualDraftRef.current = pending.draft;
    }
    if (notify && isMountedRef.current) setManualDraftStorageIssue(succeeded ? null : pending.draft.content.trim() ? 'save' : 'clear');
  }, []);

  useLayoutEffect(() => {
    const ownerId = session?.id ?? null;
    if (manualDraftOwnerRef.current !== ownerId) return undefined;
    // Do not overwrite an unreadable draft with an untouched empty form, or
    // retain metadata by itself when the user has not pasted article text.
    if (manualDraft === savedManualDraftRef.current || (!manualDraft.content.trim() && !savedManualDraftRef.current.content.trim() && !pendingManualDraftRef.current)) return undefined;
    pendingManualDraftRef.current = { draft: manualDraft, ownerId, scope: getAccountScope() };
    const timerId = window.setTimeout(() => flushManualDraft(), 500);
    return () => window.clearTimeout(timerId);
  }, [flushManualDraft, manualDraft, session?.id]);

  useEffect(() => {
    const saveWhenHidden = () => { if (document.visibilityState === 'hidden') flushManualDraft(); };
    const saveBeforeLeaving = () => flushManualDraft();
    const unsubscribe = subscribeBeforeAccountChange(() => flushManualDraft(false));
    window.addEventListener('pagehide', saveBeforeLeaving);
    document.addEventListener('visibilitychange', saveWhenHidden);
    return () => {
      // Route changes can unmount the form before its debounce expires.
      flushManualDraft(false);
      unsubscribe();
      window.removeEventListener('pagehide', saveBeforeLeaving);
      document.removeEventListener('visibilitychange', saveWhenHidden);
    };
  }, [flushManualDraft]);

  useEffect(() => {
    const nextOwnerId = session?.id ?? null;
    if (manualDraftOwnerRef.current === nextOwnerId) return;

    pendingManualDraftRef.current = null;
    manualDraftOwnerRef.current = nextOwnerId;
    sourceLookupControllerRef.current?.abort();
    sourceLookupControllerRef.current = null;
    translationLookupRef.current.controller?.abort();
    translationLookupRef.current.controller = null;
    clearTasksControllerRef.current?.abort();
    clearTasksControllerRef.current = null;
    translationActionControllersRef.current.forEach((controller) => controller.abort());
    translationActionControllersRef.current.clear();
    translationJobActionControllersRef.current.clear();
    translationJobsRevisionRef.current += 1;
    translationLookupRef.current.sequence += 1;

    const stored = nextOwnerId ? readManualBookDraftState() : { draft: null, issue: null };
    savedManualDraftRef.current = stored.draft ?? EMPTY_MANUAL_BOOK_DRAFT;
    setManualDraft(savedManualDraftRef.current);
    setHasRestoredManualDraft(Boolean(stored.draft?.content.trim()));
    setManualDraftStorageIssue(stored.issue);
    setSourceLookupError('');
    setSourceLookupMessage('');
    setManualSuccessMessage('');
    setErrorMessage('');
    knownTaskStatusRef.current = null;
    setTasks([]);
    setTranslationJobs([]);
    setTranslationActionJobIds(new Set());
    setTranslationActionErrors({});
    setTranslationError('');
    setIsClearingTasks(false);
  }, [session?.id]);

  useEffect(() => {
    if (!isTranslationView) return;
    const accountScope = JSON.stringify(session?.id ?? null);
    setTranslationJobs([]);
    setTranslationTaskReadState(INITIAL_TASK_LIST_READ_STATE);
    translationTaskReadSignalRef.current = null;
    return startPolling(async (signal) => {
      if (clearTasksControllerRef.current) return;
      const revision = translationJobsRevisionRef.current;
      translationTaskReadSignalRef.current = signal;
      setTranslationTaskReadState((state) => ({ ...state, isLoading: true }));
      try {
        const jobs = await getWholeBookTranslationJobs(signal);
        if (signal.aborted || getAccountScope() !== accountScope || clearTasksControllerRef.current) return;
        if (revision !== translationJobsRevisionRef.current) {
          // A control response is newer than this snapshot. Queue a fresh read.
          window.dispatchEvent(new Event(TRANSLATION_JOBS_CHANGED_EVENT));
          return;
        }
        setTranslationJobs(jobs);
        setTranslationTaskReadState({ hasLoaded: true, isLoading: false, error: '' });
      } catch (error) {
        if (!signal.aborted && getAccountScope() === accountScope && !clearTasksControllerRef.current && revision === translationJobsRevisionRef.current) {
          setTranslationTaskReadState((state) => ({ ...state, error: taskListReadError(error) }));
        }
      } finally {
        if (translationTaskReadSignalRef.current === signal) {
          translationTaskReadSignalRef.current = null;
          if (!signal.aborted && getAccountScope() === accountScope) setTranslationTaskReadState((state) => ({ ...state, isLoading: false }));
        }
      }
    }, { intervalMs: 4000, events: [TRANSLATION_JOBS_CHANGED_EVENT, 'online', 'focus'] });
  }, [isTranslationView, session?.id]);

  useEffect(() => {
    const targetKey = `${session?.id}:${focusedTaskId}`;
    if (!isTranslationView || !focusedTaskId || locatedTaskRef.current === targetKey) return;
    const row = [...(taskPanelRef.current?.querySelectorAll<HTMLElement>('[data-task-focus-id]') ?? [])]
      .find((element) => element.dataset.taskFocusId === `translation:${focusedTaskId}`);
    if (!row) return;
    locatedTaskRef.current = targetKey;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'center' });
  }, [focusedTaskId, isTranslationView, session?.id, taskPanelRef, translationJobs]);

  const retryTranslationTaskRead = () => {
    if (!translationTaskReadSignalRef.current && !clearTasksControllerRef.current) window.dispatchEvent(new Event(TRANSLATION_JOBS_CHANGED_EVENT));
  };

  const selectedModelOption = translationModelOptions.find(
    (option) => `${option.channel_id}::${option.model}` === translationModel,
  );
  const translationConcurrencyLimit = selectedModelOption?.max_concurrency ?? 4;
  // The model can arrive before or after the saved default. Resolve the limit
  // for both the displayed selection and the submitted snapshot on every render.
  const translationConcurrency = Math.max(1, Math.min(preferredTranslationConcurrency, translationConcurrencyLimit));
  const translationConcurrencyOptions = Array.from({ length: translationConcurrencyLimit }, (_, index) => index + 1);

  useEffect(() => {
    translationPreferencesEditedRef.current = { prompt: false, concurrency: false };
    setTranslationPrompt('');
    setTranslationConcurrency(2);
    setTranslationModel('');
    setTranslationModelOptions([]);
    setTranslationUrl('');
    setTranslationPreview(null);
    setTranslationPreferencesOpen(false);
    setIsLookingUpTranslation(false);
  }, [session?.id]);

  useEffect(() => {
    if (!isTranslationView) return;
    let active = true;
    const controller = new AbortController();
    setIsLoadingTranslationDefaults(true);
    setIsLoadingTranslationModels(true);
    setTranslationDefaultsError('');
    setTranslationModelsError('');
    void getAiModelSettings(controller.signal)
      .then((aiSettings) => {
        if (!active) return;
        if (!translationPreferencesEditedRef.current.prompt) setTranslationPrompt(aiSettings.translationPrompt);
        if (!translationPreferencesEditedRef.current.concurrency) setTranslationConcurrency(aiSettings.translationConcurrency);
      })
      .catch((error: unknown) => {
        if (active) setTranslationDefaultsError(error instanceof Error ? error.message : '翻译偏好读取失败');
      })
      .finally(() => { if (active) setIsLoadingTranslationDefaults(false); });
    const stopModelRefresh = startPolling((signal) => getTranslationModelOptions(signal)
      .then((options) => {
        if (signal.aborted) return;
        setTranslationModelsError('');
        setTranslationModelOptions(options);
        // Refresh availability without replacing a model the user selected.
        const firstAvailable = options.find((option) => option.available);
        setTranslationModel((current) => options.some((option) => `${option.channel_id}::${option.model}` === current)
          ? current : firstAvailable ? `${firstAvailable.channel_id}::${firstAvailable.model}` : '');
      })
      .catch((error: unknown) => {
        if (!signal.aborted) setTranslationModelsError(error instanceof Error ? error.message : '翻译模型读取失败');
      })
      .finally(() => { if (!signal.aborted) setIsLoadingTranslationModels(false); }),
    { intervalMs: 30000, events: [TRANSLATION_JOBS_CHANGED_EVENT, 'online', 'focus'] });
    return () => { active = false; controller.abort(); stopModelRefresh(); };
  }, [isTranslationView, session?.id, translationConfigurationReloadKey]);

  const changeTranslationConcurrency = (value: number) => {
    translationPreferencesEditedRef.current.concurrency = true;
    setTranslationConcurrency(value);
  };

  const clearRefreshTimer = useCallback(() => {
    refreshPollingStopRef.current?.();
    refreshPollingStopRef.current = null;
  }, []);

  const clearProcessingTimer = useCallback((taskId: string | undefined) => {
    if (!taskId) {
      return;
    }

    const stopProgress = processingProgressStopsRef.current.get(taskId);
    if (!stopProgress) {
      return;
    }

    stopProgress();
    processingProgressStopsRef.current.delete(taskId);
  }, []);

  const clearProcessingTimers = useCallback(() => {
    for (const stopProgress of processingProgressStopsRef.current.values()) {
      stopProgress();
    }
    processingProgressStopsRef.current.clear();
  }, []);

  const setTasksIfMounted = useCallback((nextTasks: SetStateAction<UploadTask[]>, expectedEpoch = uploadEpochRef.current) => {
    if (isMountedRef.current && expectedEpoch === uploadEpochRef.current) {
      setTasks(nextTasks);
    }
  }, []);

  const startProcessingProgress = useCallback(
    (taskId: string | undefined) => {
      if (!isMountedRef.current || !taskId || processingProgressStopsRef.current.has(taskId)) {
        return;
      }

      const stopProgress = startPolling(() => {
        setTasksIfMounted((currentTasks) =>
          currentTasks.map((task) => {
            if (task.id !== taskId || task.status !== 'processing') {
              return task;
            }

            return { ...task, progress: Math.min(PROCESSING_PROGRESS_LIMIT, task.progress + PROCESSING_PROGRESS_STEP) };
          }),
        );
      }, { immediate: false, intervalMs: PROCESSING_PROGRESS_INTERVAL_MS });
      processingProgressStopsRef.current.set(taskId, stopProgress);
    },
    [setTasksIfMounted],
  );

  // Compare each backend snapshot with the previous one; any status change
  // means the library content may have changed (a new book turned ready), so
  // the cached full book list must be refetched on the next read.
  const trackTaskStatusChanges = useCallback((backendTasks: UploadTask[]) => {
    const previousStatuses = knownTaskStatusRef.current;
    knownTaskStatusRef.current = new Map(backendTasks.map((task) => [task.id, task.status]));
    if (previousStatuses === null) {
      return;
    }

    const hasStatusChange = backendTasks.some((task) => previousStatuses.get(task.id) !== task.status);
    if (hasStatusChange) {
      invalidateBookListCache();
    }
  }, []);

  const refreshBackendTasks = useCallback(
    async (
      signal?: AbortSignal,
      expectedEpoch = uploadEpochRef.current,
      keepLocalTasks = true,
    ) => {
      if (signal?.aborted || expectedEpoch !== uploadEpochRef.current || !isMountedRef.current || clearTasksControllerRef.current) {
        return;
      }

      const clearRevision = taskClearRevisionRef.current;
      const receiptRevision = uploadReceiptRevisionRef.current;
      if (uploadTaskReadTokenRef.current) return;
      const token = Symbol('upload-task-read');
      uploadTaskReadTokenRef.current = token;
      const isCurrent = () => !signal?.aborted && expectedEpoch === uploadEpochRef.current && isMountedRef.current && !clearTasksControllerRef.current && clearRevision === taskClearRevisionRef.current;
      setUploadTaskReadState((state) => ({ ...state, isLoading: true }));
      try {
        const backendTasks = await getUploadTasks(signal);

        if (!isCurrent()) return;
        // A snapshot started before a confirmed upload/reprocess cannot erase
        // its receipt or regress a completed task. The next poll reads anew.
        if (receiptRevision !== uploadReceiptRevisionRef.current) return;

        setUploadTaskReadState({ hasLoaded: true, isLoading: false, error: '' });
        trackTaskStatusChanges(backendTasks);
        setTasksIfMounted((currentTasks) => {
          const localTasks = keepLocalTasks ? currentTasks.filter((task) => isLocalUploadTask(task)) : [];
          const smoothedBackendTasks = backendTasks.map((task) => smoothBackendTaskProgress(task, currentTasks));
          const mergedTasks = mergeUploadTasks(localTasks, smoothedBackendTasks);
          for (const task of mergedTasks) {
            if (task.status === 'processing') {
              startProcessingProgress(task.id);
            }
            if (task.status === 'ready' || task.status === 'failed') {
              clearProcessingTimer(task.id);
            }
          }
          if (!isUploadingRef.current && !hasActiveUploadTask(mergedTasks)) {
            clearRefreshTimer();
          }
          return mergedTasks;
        }, expectedEpoch);
      } catch (error) {
        if (isCurrent()) {
          setUploadTaskReadState((state) => ({ ...state, isLoading: false, error: taskListReadError(error) }));
          // The API already retries transient reads. Stop the faster interval
          // after failure so it cannot keep the explicit retry permanently busy.
          // Retry, focus, online or a new task event starts a fresh poller.
          clearRefreshTimer();
        }
      } finally {
        if (uploadTaskReadTokenRef.current === token) {
          uploadTaskReadTokenRef.current = null;
          if (isCurrent()) setUploadTaskReadState((state) => ({ ...state, isLoading: false }));
        }
      }
    },
    [clearProcessingTimer, clearRefreshTimer, setTasksIfMounted, startProcessingProgress, trackTaskStatusChanges],
  );

  const startTaskPolling = useCallback(() => {
    if (!isMountedRef.current || refreshPollingStopRef.current !== null) {
      return;
    }

    const expectedEpoch = uploadEpochRef.current;
    refreshPollingStopRef.current = startPolling(
      (signal) => refreshBackendTasks(signal, expectedEpoch),
      { intervalMs: UPLOAD_TASK_REFRESH_INTERVAL_MS },
    );
  }, [refreshBackendTasks]);

  const retryUploadTaskRead = () => {
    if (uploadTaskReadTokenRef.current || clearTasksControllerRef.current) return;
    clearRefreshTimer();
    startTaskPolling();
  };

  useEffect(() => {
    if (isTranslationView) return;
    const events = [UPLOAD_TASKS_CHANGED_EVENT, 'online', 'focus'];
    events.forEach((event) => window.addEventListener(event, startTaskPolling));
    return () => events.forEach((event) => window.removeEventListener(event, startTaskPolling));
  }, [isTranslationView, startTaskPolling]);

  // Establish the new upload session before its initial request captures the epoch.
  useEffect(() => {
    uploadEpochRef.current += 1;
    uploadTaskReadTokenRef.current = null;
    setUploadTaskReadState(INITIAL_TASK_LIST_READ_STATE);
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
    uploadAttemptsRef.current.clear();
    reprocessRequestIdsRef.current.clear();
    serverTaskIdsRef.current.clear();
    clearRefreshTimer();
    clearProcessingTimers();
    isUploadingRef.current = false;
    setIsUploading(false);
  }, [clearProcessingTimers, clearRefreshTimer, session?.id]);

  useEffect(() => {
    if (isTranslationView) return;
    const expectedEpoch = uploadEpochRef.current;
    const clearRevision = taskClearRevisionRef.current;
    const controller = new AbortController();
    const token = Symbol('initial-upload-task-read');
    initialUploadTaskReadControllerRef.current = controller;
    uploadTaskReadTokenRef.current = token;
    setTasks([]);
    setErrorMessage('');
    void getUploadTasks(controller.signal)
      .then((initialTasks) => {
        if (controller.signal.aborted || expectedEpoch !== uploadEpochRef.current || !isMountedRef.current || clearTasksControllerRef.current || clearRevision !== taskClearRevisionRef.current) {
          return;
        }
        setUploadTaskReadState({ hasLoaded: true, isLoading: false, error: '' });
        knownTaskStatusRef.current = new Map(initialTasks.map((task) => [task.id, task.status]));
        // A slow initial snapshot must not replace uploads started while it was loading.
        setTasksIfMounted((currentTasks) => mergeUploadTasks(currentTasks, initialTasks), expectedEpoch);
        // Resume polling for tasks the background worker is still chewing on,
        // so returning to this page no longer leaves them stuck on
        // "processing" forever even after the worker finished.
        if (hasActiveUploadTask(initialTasks)) {
          for (const task of initialTasks) {
            if (task.status === 'processing') {
              startProcessingProgress(task.id);
            }
          }
          startTaskPolling();
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && expectedEpoch === uploadEpochRef.current && isMountedRef.current && !clearTasksControllerRef.current && clearRevision === taskClearRevisionRef.current) {
          setUploadTaskReadState((state) => ({ ...state, isLoading: false, error: taskListReadError(error) }));
        }
      })
      .finally(() => {
        if (uploadTaskReadTokenRef.current === token) uploadTaskReadTokenRef.current = null;
        if (initialUploadTaskReadControllerRef.current === controller) initialUploadTaskReadControllerRef.current = null;
      });
    return () => controller.abort();
  }, [isTranslationView, session?.id, setTasksIfMounted, startProcessingProgress, startTaskPolling]);

  useEffect(
    () => {
      const lookupState = translationLookupRef.current;
      const translationActionControllers = translationActionControllersRef.current;
      const translationJobActionControllers = translationJobActionControllersRef.current;
      // React StrictMode replays effects in development. Restore the mounted
      // flag on the second setup so task loading and progress updates are not
      // accidentally suppressed after the replay cleanup.
      isMountedRef.current = true;

      return () => {
        isMountedRef.current = false;
        sourceLookupControllerRef.current?.abort();
        sourceLookupControllerRef.current = null;
        lookupState.controller?.abort();
        lookupState.controller = null;
        lookupState.sequence += 1;
        clearTasksControllerRef.current?.abort();
        clearTasksControllerRef.current = null;
        translationActionControllers.forEach((controller) => controller.abort());
        translationActionControllers.clear();
        translationJobActionControllers.clear();
        translationJobsRevisionRef.current += 1;
        clearRefreshTimer();
        clearProcessingTimers();
      };
    },
    [clearProcessingTimers, clearRefreshTimer],
  );

  const handleFilesSelected = async (files: File[], metadata?: (UploadBookMetadata | undefined)[], requestIds?: (string | undefined)[]): Promise<boolean> => {
    if (isUploadingRef.current || clearTasksControllerRef.current) {
      return false;
    }

    const uploadEpoch = uploadEpochRef.current;
    setErrorMessage('');
    const attempts = files.map((file, index) => createUploadAttempt(file, metadata?.[index], requestIds?.[index]));
    const attemptIds = new Set(attempts.map((attempt) => attempt.requestId));
    const replacedTasks = new Set<string>();
    for (const [taskId, attempt] of uploadAttemptsRef.current) {
      if (!attemptIds.has(attempt.requestId)) continue;
      replacedTasks.add(taskId);
      uploadAttemptsRef.current.delete(taskId);
      abortControllersRef.current.delete(taskId);
    }
    const optimisticTasks = createQueuedUploadTasks(files);
    const abortControllers = files.map(() => new AbortController());
    optimisticTasks.forEach((task, index) => {
      abortControllersRef.current.set(task.id, abortControllers[index]);
      uploadAttemptsRef.current.set(task.id, attempts[index]);
    });
    setTasksIfMounted((currentTasks) => mergeUploadTasks(optimisticTasks, currentTasks.filter((task) => !replacedTasks.has(task.id))), uploadEpoch);
    setIsUploading(true);
    isUploadingRef.current = true;

    try {
      const acceptedTasks = await uploadBookFiles(files, {
        metadata: attempts.map((attempt) => attempt.metadata),
        requestIds: attempts.map((attempt) => attempt.requestId),
        signals: abortControllers.map((controller) => controller.signal),
        onFileAccepted: (file, index, response) => {
          if (!isMountedRef.current || uploadEpoch !== uploadEpochRef.current) return;
          uploadReceiptRevisionRef.current += 1;
          const localTaskId = optimisticTasks[index]?.id;
          const taskId = adoptBackendTaskId(localTaskId, response.task_id, response.book_id ?? undefined, uploadEpoch);
          if (response.book_id) uploadAttemptsRef.current.delete(taskId);
          updateOptimisticTask(taskId, createAcceptedUploadTask(file, response), uploadEpoch);
          if (response.status === 'processing') startProcessingProgress(taskId);
          startTaskPolling();
          void refreshBackendTasks();
        },
        onFileComplete: (_file, index) => {
          if (!isMountedRef.current || uploadEpoch !== uploadEpochRef.current) return;
          const taskId = resolveTaskId(optimisticTasks[index]?.id);
          clearProcessingTimer(taskId);
          updateOptimisticTask(taskId, { message: '已保存并解析完成', progress: 100, status: 'ready' }, uploadEpoch);
          void refreshBackendTasks();
        },
        onFileError: (_file, index, error) => {
          if (!isMountedRef.current || uploadEpoch !== uploadEpochRef.current) return;
          const taskId = resolveTaskId(optimisticTasks[index]?.id);
          clearProcessingTimer(taskId);
          const message = error instanceof Error ? error.message : '上传失败';
          updateOptimisticTask(taskId, { message, progress: 0, status: 'failed' }, uploadEpoch);
          void refreshBackendTasks();
        },
        onFileProcessing: (_file, index) => {
          if (!isMountedRef.current || uploadEpoch !== uploadEpochRef.current) return;
          const taskId = resolveTaskId(optimisticTasks[index]?.id);
          updateOptimisticTask(taskId, { message: '上传完成，服务器正在解析正文和目录', progress: 72, status: 'processing' }, uploadEpoch);
          startProcessingProgress(taskId);
        },
        onFileProgress: (_file, index, progress) => {
          if (!isMountedRef.current || uploadEpoch !== uploadEpochRef.current) return;
          updateOptimisticTask(resolveTaskId(optimisticTasks[index]?.id), { message: '正在上传到服务器', progress, status: 'uploading' }, uploadEpoch);
        },
        onFileStart: (_file, index) => {
          if (!isMountedRef.current || uploadEpoch !== uploadEpochRef.current) return;
          updateOptimisticTask(resolveTaskId(optimisticTasks[index]?.id), { message: '正在建立上传连接', progress: 8, status: 'uploading' }, uploadEpoch);
        },
      });
      setTasksIfMounted((currentTasks) => mergeUploadTasks(
        currentTasks.filter((task) => !isLocalUploadTask(task) || task.status === 'failed'),
        acceptedTasks,
      ), uploadEpoch);
      return true;
    } catch (error: unknown) {
      if (isMountedRef.current && uploadEpoch === uploadEpochRef.current) {
        setErrorMessage(error instanceof Error ? error.message : '上传失败');
      }
      return false;
    } finally {
      if (isMountedRef.current && uploadEpoch === uploadEpochRef.current) {
        setIsUploading(false);
        setErrorMessage((current) => current === UPLOAD_BUSY_MESSAGE ? '' : current);
      }
      if (uploadEpoch === uploadEpochRef.current) {
        isUploadingRef.current = false;
      }
      // Keep failures that happened before the server created a task. They
      // contain the actionable local error (for example a 0 B source file).
      if (uploadEpoch === uploadEpochRef.current) void refreshBackendTasks();
    }
  };

  const handleManualSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!manualDraft.content.trim()) {
      setErrorMessage('请先粘贴文章正文');
      return;
    }

    setErrorMessage('');
    setManualSuccessMessage('');
    if (isUploadingRef.current || clearTasksControllerRef.current) return;
    const expectedEpoch = uploadEpochRef.current;
    const accountScope = getAccountScope();
    sourceLookupControllerRef.current?.abort();
    const submission = reserveManualBookSubmission(manualDraft);
    setManualDraft(submission);
    pendingManualDraftRef.current = { draft: submission, ownerId: manualDraftOwnerRef.current, scope: accountScope };
    flushManualDraft();
    const prepared = prepareManualBook(submission);
    const succeeded = await handleFilesSelected([prepared.file], [prepared.metadata], [submission.requestId]);
    if (!succeeded || !isMountedRef.current || expectedEpoch !== uploadEpochRef.current || accountScope !== getAccountScope()) return;

    pendingManualDraftRef.current = null;
    setManualDraftStorageIssue(clearManualBookDraft() ? null : 'clear');
    savedManualDraftRef.current = EMPTY_MANUAL_BOOK_DRAFT;
    setManualDraft(EMPTY_MANUAL_BOOK_DRAFT);
    setHasRestoredManualDraft(false);
    setSourceLookupError('');
    setSourceLookupMessage('');
    setManualSuccessMessage(`《${prepared.title}》原文件已保存，可在任务记录查看解析状态。`);
  };

  const retryManualDraftPersistence = () => {
    if (isUploadingRef.current || manualDraftOwnerRef.current !== (session?.id ?? null)) return;
    // A newer edit always wins over an older failed write or deletion.
    if (pendingManualDraftRef.current) { flushManualDraft(); return; }
    const recovered = retryManualBookDraftStorage();
    setManualDraftStorageIssue(recovered.issue);
    if (manualDraftStorageIssue === 'read' && recovered.draft) {
      const merged = mergeRecoveredManualBookDraft(manualDraft, savedManualDraftRef.current, recovered.draft);
      savedManualDraftRef.current = recovered.draft;
      setManualDraft(merged);
      setHasRestoredManualDraft(true);
    }
  };

  const handleSourceLookup = async (rawUrl = manualDraft.sourceUrl) => {
    const url = rawUrl.trim();
    if (!url) {
      setSourceLookupError('请粘贴作品链接');
      return;
    }

    sourceLookupControllerRef.current?.abort();
    const controller = new AbortController();
    sourceLookupControllerRef.current = controller;
    const draftSnapshot = manualDraft;
    setIsLookingUpSource(true);
    setSourceLookupError('');
    setSourceLookupMessage('');
    try {
      const metadata = await getWorkSourceMetadata(url, controller.signal);
      if (!isMountedRef.current || controller.signal.aborted) return;
      setManualDraft((draft) => updateManualBookDraft(draft, mergeManualSourceMetadata(draft, draftSnapshot, url, metadata)));
      setSourceLookupMessage(manualSourceMetadataMessage(metadata));
    } catch (error) {
      if (controller.signal.aborted) return;
      setSourceLookupError(error instanceof Error ? error.message : '作品信息读取失败');
    } finally {
      if (sourceLookupControllerRef.current === controller) {
        sourceLookupControllerRef.current = null;
        if (isMountedRef.current) setIsLookingUpSource(false);
      }
    }
  };

  const handleTranslationLookup = useCallback(async (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url) return;
    const sequence = (translationLookupRef.current.sequence += 1);
    translationLookupRef.current.requested = url;
    translationLookupRef.current.controller?.abort();
    const controller = new AbortController();
    translationLookupRef.current.controller = controller;
    setIsLookingUpTranslation(true);
    setTranslationError('');
    try {
      const metadata = await getWorkSourceMetadata(url, controller.signal);
      if (!isMountedRef.current || controller.signal.aborted || !isLatestTranslationLookup(sequence, translationLookupRef.current)) return;
      // Remember the normalised URL before writing it back, so the debounce
      // effect recognises it as already resolved instead of looking it up again.
      translationLookupRef.current.requested = metadata.source_url;
      setTranslationUrl(metadata.source_url);
      setTranslationPreview(metadata);
    } catch (error) {
      if (!isMountedRef.current || controller.signal.aborted || !isLatestTranslationLookup(sequence, translationLookupRef.current)) return;
      setTranslationPreview(null);
      setTranslationError(error instanceof Error ? error.message : '作品信息读取失败');
    } finally {
      // A superseded lookup must not clear the spinner the newest one owns.
      if (translationLookupRef.current.controller === controller) {
        translationLookupRef.current.controller = null;
      }
      if (isMountedRef.current && !controller.signal.aborted && isLatestTranslationLookup(sequence, translationLookupRef.current)) {
        setIsLookingUpTranslation(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!shouldRequestTranslationLookup(translationUrl, translationLookupRef.current, uploadMode)) return undefined;
    const timerId = window.setTimeout(() => void handleTranslationLookup(translationUrl), 650);
    return () => window.clearTimeout(timerId);
  }, [handleTranslationLookup, translationUrl, uploadMode]);

  const handleStartTranslation = () => {
    if (clearTasksControllerRef.current || isLoadingTranslationDefaults || isLoadingTranslationModels || translationDefaultsError || translationModelsError) return;
    const url = translationUrl.trim();
    if (!url) return;
    const lane = selectedModelOption;
    if (!lane?.available) {
      setTranslationError('请先选择本次使用的渠道和模型');
      return;
    }
    // Persist the complete submission before freeing the form for the next work.
    if (!translationSubmissionQueue.enqueue({
      sourceUrl: url,
      customInstructions: translationPrompt,
      requestConcurrency: translationConcurrency,
      model: lane.model,
      channelId: lane.channel_id,
      modelLabel: lane.label,
    })) return;
    setTranslationUrl('');
    setTranslationPreview(null);
    setTranslationError('');
    // Invalidate any lookup still in flight for this URL, otherwise it would
    // resolve after submission and write the link back into the cleared field.
    translationLookupRef.current.sequence += 1;
    translationLookupRef.current.controller?.abort();
    translationLookupRef.current.controller = null;
    translationLookupRef.current.requested = '';
    setIsLookingUpTranslation(false);
  };

  const handleRetryTranslation = async (jobId: string) => {
    await updateTranslationJob(jobId, (signal) => retryWholeBookTranslation(jobId, signal), '翻译任务重试失败');
  };

  const handleDeleteTranslation = async (job: WholeBookTranslationJob) => {
    if (translationJobActionControllersRef.current.has(job.id) || clearTasksControllerRef.current) return;
    const confirmed = window.confirm(job.status === 'paused'
      ? `放弃《${job.title}》的后续翻译？\n\n已完成并加入书架的 ${job.completed_chapters} 话会保留；翻译断点、通知和任务记录将删除。`
      : `删除《${job.title}》的翻译记录？\n\n书架里的图书不会被删除。`);
    if (!confirmed) return;
    await updateTranslationJob(job.id, async (signal) => {
      await deleteWholeBookTranslation(job.id, signal);
      return null;
    }, '翻译记录删除失败');
  };

  const updateTranslationJob = async (jobId: string, action: (signal: AbortSignal) => Promise<WholeBookTranslationJob | null>, failureMessage: string) => {
    const actions = translationJobActionControllersRef.current;
    if (actions.has(jobId) || clearTasksControllerRef.current) return;
    const controller = new AbortController();
    actions.set(jobId, controller);
    translationActionControllersRef.current.add(controller);
    setTranslationActionJobIds(new Set(actions.keys()));
    setTranslationActionErrors((errors) => ({ ...errors, [jobId]: '' }));
    try {
      const updated = await action(controller.signal);
      if (!isMountedRef.current || controller.signal.aborted) return;
      translationJobsRevisionRef.current += 1;
      setTranslationJobs((jobs) => updated
        ? jobs.map((job) => job.id === jobId ? updated : job)
        : jobs.filter((job) => job.id !== jobId));
    } catch (error) {
      if (isMountedRef.current && !controller.signal.aborted) {
        setTranslationActionErrors((errors) => ({ ...errors, [jobId]: error instanceof Error ? error.message : failureMessage }));
      }
    } finally {
      translationActionControllersRef.current.delete(controller);
      if (actions.get(jobId) === controller) {
        actions.delete(jobId);
        if (isMountedRef.current && !controller.signal.aborted) setTranslationActionJobIds(new Set(actions.keys()));
      }
    }
  };

  function updateOptimisticTask(taskId: string | undefined, changes: Partial<UploadTask>, expectedEpoch = uploadEpochRef.current) {
    if (!taskId) {
      return;
    }

    setTasksIfMounted((currentTasks) => currentTasks.map((task) => (task.id === taskId ? { ...task, ...changes } : task)), expectedEpoch);
  }

  function resolveTaskId(localTaskId: string | undefined): string | undefined {
    return localTaskId ? (serverTaskIdsRef.current.get(localTaskId) ?? localTaskId) : undefined;
  }

  function adoptBackendTaskId(localTaskId: string | undefined, serverTaskId: string, bookId: string | undefined, expectedEpoch = uploadEpochRef.current): string {
    if (expectedEpoch !== uploadEpochRef.current) {
      return serverTaskId;
    }
    if (!localTaskId || localTaskId === serverTaskId) {
      return serverTaskId;
    }

    serverTaskIdsRef.current.set(localTaskId, serverTaskId);
    clearProcessingTimer(localTaskId);

    const controller = abortControllersRef.current.get(localTaskId);
    if (controller) {
      abortControllersRef.current.delete(localTaskId);
      abortControllersRef.current.set(serverTaskId, controller);
    }
    const attempt = uploadAttemptsRef.current.get(localTaskId);
    if (attempt) {
      uploadAttemptsRef.current.delete(localTaskId);
      uploadAttemptsRef.current.set(serverTaskId, attempt);
    }

    setTasksIfMounted((currentTasks) => adoptUploadTask(currentTasks, localTaskId, serverTaskId, bookId), expectedEpoch);
    return serverTaskId;
  }

  const handleClearCompletedTasks = async () => {
    if (clearTasksControllerRef.current || isUploadingRef.current || translationActionControllersRef.current.size > 0 || (isTranslationView && translationSubmissionQueue.hasPending())) return;
    const finishedTasks = tasks.filter((task) => task.status === 'ready' || task.status === 'failed');
    const finishedTranslationJobs = translationJobs.filter((job) => job.status === 'ready' || job.status === 'failed' || job.status === 'rejected');
    if (finishedTasks.length === 0 && finishedTranslationJobs.length === 0) {
      return;
    }

    const expectedEpoch = uploadEpochRef.current;
    const controller = new AbortController();
    clearTasksControllerRef.current = controller;
    clearRefreshTimer();
    initialUploadTaskReadControllerRef.current?.abort();
    uploadTaskReadTokenRef.current = null;
    taskClearRevisionRef.current += 1;
    translationJobsRevisionRef.current += 1;
    setIsClearingTasks(true);
    setErrorMessage('');
    try {
      if (isTranslationView) {
        await clearCompletedWholeBookTranslations(controller.signal);
        const jobs = await getWholeBookTranslationJobs(controller.signal);
        if (controller.signal.aborted || expectedEpoch !== uploadEpochRef.current || !isMountedRef.current) return;
        translationJobsRevisionRef.current += 1;
        setTranslationJobs(jobs);
        setTranslationTaskReadState({ hasLoaded: true, isLoading: false, error: '' });
      } else {
        await clearCompletedUploadTasks(controller.signal);
        const nextTasks = await getUploadTasks(controller.signal);
        if (controller.signal.aborted || expectedEpoch !== uploadEpochRef.current || !isMountedRef.current) return;
        setUploadTaskReadState({ hasLoaded: true, isLoading: false, error: '' });
        setTasksIfMounted(nextTasks, expectedEpoch);
        const retainedIds = new Set(nextTasks.map((task) => task.id));
        for (const taskId of uploadAttemptsRef.current.keys()) if (!retainedIds.has(taskId)) uploadAttemptsRef.current.delete(taskId);
        for (const taskId of reprocessRequestIdsRef.current.keys()) if (!retainedIds.has(taskId)) reprocessRequestIdsRef.current.delete(taskId);
      }
    } catch (error) {
      if (!controller.signal.aborted && expectedEpoch === uploadEpochRef.current && isMountedRef.current) {
        setErrorMessage(`记录清理或刷新失败：${taskListReadError(error)}`);
      }
    } finally {
      if (clearTasksControllerRef.current === controller) {
        clearTasksControllerRef.current = null;
        if (isMountedRef.current && !controller.signal.aborted) {
          setIsClearingTasks(false);
          if (isTranslationView) window.dispatchEvent(new Event(TRANSLATION_JOBS_CHANGED_EVENT));
          else startTaskPolling();
        }
      }
    }
  };

  const handleCancelTask = (task: UploadTask) => {
    const controller = abortControllersRef.current.get(task.id);
    if (controller) {
      controller.abort();
    }
  };

  const handleRetryTask = (task: UploadTask) => {
    if (clearTasksControllerRef.current) return;
    if (isUploadingRef.current) {
      setErrorMessage(UPLOAD_BUSY_MESSAGE);
      return;
    }
    if (task.bookId) {
      void handleReprocessTask(task);
      return;
    }
    const attempt = uploadAttemptsRef.current.get(task.id);
    if (attempt && attempt.accountScope !== getAccountScope()) return;
    const file = attempt?.file;
    if (!file || file.size <= 0) {
      taskAwaitingReselectRef.current = task.id;
      setErrorMessage(
        file
          ? '这个文件被选中时还没有生成完成。刷新页面无法恢复旧文件，请重新选择现在已经完成的文件。'
          : '刷新后浏览器不能继续读取原文件，请重新选择文件再上传。',
      );
      uploadFileInputRef.current?.click();
      return;
    }

    setTasksIfMounted((currentTasks) => currentTasks.filter((currentTask) => currentTask.id !== task.id));
    uploadAttemptsRef.current.delete(task.id);
    void handleFilesSelected([file], [attempt?.metadata], [attempt?.requestId]);
  };

  const handleReprocessTask = async (task: UploadTask) => {
    if (!task.bookId || isUploadingRef.current || clearTasksControllerRef.current) return;
    const expectedEpoch = uploadEpochRef.current;
    const requestId = reprocessRequestIdsRef.current.get(task.id) ?? createRequestId();
    reprocessRequestIdsRef.current.set(task.id, requestId);
    const controller = new AbortController();
    abortControllersRef.current.set(task.id, controller);
    isUploadingRef.current = true;
    setIsUploading(true);
    setErrorMessage('');
    updateOptimisticTask(task.id, { status: 'queued', progress: 0, message: '正在请求重新解析原文件' }, expectedEpoch);
    try {
      const response = await reprocessUploadedBook(task.bookId, requestId, controller.signal);
      if (!isMountedRef.current || controller.signal.aborted || expectedEpoch !== uploadEpochRef.current) return;
      uploadReceiptRevisionRef.current += 1;
      reprocessRequestIdsRef.current.delete(task.id);
      const nextId = adoptBackendTaskId(task.id, response.task_id, response.book_id ?? task.bookId, expectedEpoch);
      updateOptimisticTask(nextId, { status: response.status, progress: response.status === 'ready' ? 100 : response.status === 'failed' ? 0 : 12,
        message: response.status === 'ready' ? '重新解析完成' : response.status === 'failed' ? '原文件解析失败，可查看失败原因' : '正在重新解析原文件' }, expectedEpoch);
      if (response.status === 'processing') startProcessingProgress(nextId);
      startTaskPolling();
      void refreshBackendTasks();
    } catch (error) {
      if (!isMountedRef.current || controller.signal.aborted || expectedEpoch !== uploadEpochRef.current) return;
      updateOptimisticTask(task.id, { status: 'failed', progress: 0, message: error instanceof Error ? error.message : '重新解析请求失败，请重试' }, expectedEpoch);
    } finally {
      if (expectedEpoch === uploadEpochRef.current) {
        isUploadingRef.current = false;
        if (isMountedRef.current) setIsUploading(false);
      }
    }
  };

  const handleDropzoneFilesSelected = (files: File[]) => {
    if (isUploadingRef.current || clearTasksControllerRef.current) return;
    const taskId = taskAwaitingReselectRef.current;
    if (taskId) {
      taskAwaitingReselectRef.current = null;
      uploadAttemptsRef.current.delete(taskId);
      setTasksIfMounted((currentTasks) => currentTasks.filter((task) => task.id !== taskId));
      setErrorMessage('');
    }
    void handleFilesSelected(files);
  };

  return (
    <div className="upload-workspace mx-auto w-full max-w-[1200px] space-y-4">
      <header className="flex items-center justify-between gap-4 border-b border-ink/10 pb-4 dark:border-white/10">
        <div>
          <h1 className="app-page-title font-display text-2xl font-semibold text-ink dark:text-night-ink">{isTranslationView ? '翻译' : '添加图书'}</h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{isTranslationView ? '作品翻译、更新译稿与任务记录。' : '上传文件，或粘贴正文保存到书架。'}</p>
        </div>
        <Link className="inline-flex min-h-11 shrink-0 items-center gap-2 text-sm text-accent dark:text-peach" to={isTranslationView ? ROUTES.upload : ROUTES.translations}>
          {isTranslationView ? <><FileUp className="h-4 w-4" />上传图书</> : <><Sparkles className="h-4 w-4" />翻译任务</>}
        </Link>
      </header>
      <FormContainer className="translation-create group">
        {isTranslationView && <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-ink dark:text-night-ink">
          <span className="flex items-center gap-2"><BookOpenText className="h-4 w-4 text-accent dark:text-peach" />新建翻译</span>
          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
        </summary>}
        {!isTranslationView && <div aria-label="添加方式" className="upload-mode-tabs grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1 dark:bg-white/[0.05]" role="tablist" onKeyDown={(event) => {
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]'));
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          tabs[next]?.focus();
          tabs[next]?.click();
        }}>
          <button
            aria-selected={uploadMode === 'file'}
            id="upload-mode-file"
            aria-controls="upload-mode-panel"
            tabIndex={uploadMode === 'file' ? 0 : -1}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition ${uploadMode === 'file' ? 'bg-white text-stone-900 shadow-sm dark:bg-white/10 dark:text-night-ink' : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-night-ink'}`}
            onClick={() => setUploadMode('file')}
            role="tab"
            type="button"
          >
            <FileUp className="h-4 w-4" />
            上传文件
          </button>
          <button
            aria-selected={uploadMode === 'manual'}
            id="upload-mode-manual"
            aria-controls="upload-mode-panel"
            tabIndex={uploadMode === 'manual' ? 0 : -1}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition ${uploadMode === 'manual' ? 'bg-white text-stone-900 shadow-sm dark:bg-white/10 dark:text-night-ink' : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-night-ink'}`}
            onClick={() => setUploadMode('manual')}
            role="tab"
            type="button"
          >
            <PenLine className="h-4 w-4" />
            手动添加
          </button>
        </div>}
        <div id="upload-mode-panel" role={isTranslationView ? undefined : 'tabpanel'} aria-labelledby={isTranslationView ? undefined : `upload-mode-${uploadMode}`}>
        {uploadMode === 'file' ? (
          <div className="mt-6">
            <UploadDropzone disabled={isClearingTasks} fileInputRef={uploadFileInputRef} isUploading={isUploading} onFilesSelected={handleDropzoneFilesSelected} />
          </div>
        ) : uploadMode === 'translation' ? (
          <section className="mt-6">
            <label className="grid gap-2 text-sm font-medium text-stone-700 dark:text-night-copy" htmlFor="translation-source-url">
              作品链接
              <div className="relative">
                <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                <input
                  className="min-h-12 w-full rounded-md border border-stone-200 bg-shell py-3 pl-10 pr-11 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                  id="translation-source-url"
                  maxLength={1000}
                  onChange={(event) => {
                    setTranslationUrl(event.target.value);
                    setTranslationPreview(null);
                    setTranslationError('');
                  }}
                  inputMode="url"
                  placeholder="粘贴 Kakuyomu、成为小说家吧、ハーメルン或 pixiv 作品链接"
                  type="text"
                  value={translationUrl}
                />
                {isLookingUpTranslation && (
                  <span aria-label="正在读取作品资料" className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-accent" role="status">
                    <LoaderCircle aria-hidden="true" className="block h-4 w-4 animate-spin" />
                  </span>
                )}
              </div>
            </label>
            {translationPreview && (
              <div className="mt-6 border-y border-stone-200 py-5 dark:border-white/10">
                <div className="flex min-w-0 items-start gap-4">
                  {translationPreview.cover_url && <img alt="" className="h-24 w-16 shrink-0 rounded object-cover shadow-sm" src={translationPreview.cover_url} />}
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold leading-6 text-stone-900 dark:text-night-ink">{translationPreview.title}</h3>
                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{translationPreview.author}</p>
                    <p className="mt-3 text-xs tabular-nums text-stone-500 dark:text-stone-400">
                      {translationPreview.episode_count.toLocaleString()} 话 · {translationPreview.character_count.toLocaleString()} 字 · {translationPreview.publication_status === 'completed' ? '已完结' : '连载中'}
                    </p>
                    {translationPreview.original_title && <p className="mt-1 truncate text-[11px] text-stone-400" title={translationPreview.original_title}>{translationPreview.original_title}</p>}
                  </div>
                </div>
              </div>
            )}
            {isLoadingTranslationModels && (
              <p className="mt-4 flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400" role="status"><LoaderCircle aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />正在读取翻译模型…</p>
            )}
            {translationModelsError && (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-red-600 dark:text-red-300" role="alert">
                <span className="min-w-0 [overflow-wrap:anywhere]">翻译模型读取失败：{translationModelsError}</span>
                <button className="min-h-10 px-2 font-medium text-accent" onClick={() => setTranslationConfigurationReloadKey((current) => current + 1)} type="button">重试读取翻译模型</button>
              </div>
            )}
            {translationModelOptions.length === 0 && !isLoadingTranslationModels && !translationModelsError && (
              <p className="mt-4 text-xs text-amber-700 dark:text-amber-300">
                还没有可用的翻译模型，<Link className="underline underline-offset-4" to={ROUTES.settings}>前往设置添加渠道和模型</Link>。
              </p>
            )}
            {translationModelOptions.length > 0 && (
              <label className="mt-4 grid gap-2 text-sm font-medium text-stone-700 dark:text-night-copy" htmlFor="translation-model">
                本次使用渠道和模型
                <select
                  className="min-h-11 w-full rounded-md border border-stone-200 bg-shell px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-[#211d25]"
                  id="translation-model"
                  onChange={(event) => setTranslationModel(event.target.value)}
                  value={translationModel}
                >
                  <option value="">请选择</option>
                  {Object.entries(
                    translationModelOptions.reduce<Record<string, TranslationModelOption[]>>((groups, option) => {
                      (groups[option.channel_name] ??= []).push(option);
                      return groups;
                    }, {}),
                  ).map(([channelName, options]) => (
                    <optgroup key={channelName} label={channelName}>
                      {options.map((option) => (
                        <option
                          disabled={!option.available}
                          key={`${option.channel_id}::${option.model}`}
                          value={`${option.channel_id}::${option.model}`}
                        >
                          {option.display_name}
                          {option.available
                            ? option.active_job_count > 0 ? ` · ${option.active_job_count} 本在翻` : ''
                            : ` · ${option.unavailable_reason || '暂时不可用'}`}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span className="text-xs font-normal text-stone-400">
                  提交后固定使用所选模型，不会在翻译途中切换；暂停后可以随时更换。
                </span>
              </label>
            )}
            <div className="mt-4 border-b border-stone-200 pb-4 dark:border-white/10">
              <button
                aria-controls="translation-preferences"
                aria-expanded={translationPreferencesOpen}
                className="flex min-h-10 w-full items-center gap-2 text-left text-sm text-stone-600 transition hover:text-stone-900 dark:text-night-soft dark:hover:text-night-ink"
                onClick={() => setTranslationPreferencesOpen((open) => !open)}
                type="button"
              >
                <SlidersHorizontal className="h-4 w-4 text-accent" />
                <span className="flex-1">本次翻译偏好</span>
                {translationPrompt.trim() && <span className="text-xs text-accent">已设置</span>}
                <ChevronDown className={`h-4 w-4 transition-transform ${translationPreferencesOpen ? 'rotate-180' : ''}`} />
              </button>
              {isLoadingTranslationDefaults && <p className="mt-2 text-xs text-stone-500 dark:text-stone-400" role="status">正在读取已保存的翻译偏好，你可以先填写本次要求。</p>}
              {translationDefaultsError && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-600 dark:text-red-300" role="alert">
                  <span className="min-w-0 [overflow-wrap:anywhere]">翻译偏好读取失败：{translationDefaultsError}；本次输入已保留。</span>
                  <button className="min-h-10 px-2 font-medium text-accent" onClick={() => setTranslationConfigurationReloadKey((current) => current + 1)} type="button">重试读取翻译偏好</button>
                </div>
              )}
              {translationPreferencesOpen && (
                <div className="mt-2 space-y-5" id="translation-preferences">
                  <label className="block">
                  <textarea
                    aria-label="本次翻译要求"
                    className="min-h-32 w-full resize-y rounded-md border border-stone-200 bg-shell px-3 py-2 text-sm leading-6 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                    maxLength={6000}
                    onChange={(event) => { translationPreferencesEditedRef.current.prompt = true; setTranslationPrompt(event.target.value); }}
                    placeholder="例如：指定人名译法、人物口吻、叙述风格，或要求不要弱化特定场景。"
                    value={translationPrompt}
                  />
                  <span className="mt-1 block text-right text-[11px] tabular-nums text-stone-400">{translationPrompt.length.toLocaleString()} / 6,000</span>
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-xs font-medium text-stone-600 dark:text-night-soft">并发请求</span>
                    {translationConcurrencyLimit > 4 ? (
                      <select aria-label="本次精翻并发请求数" className="min-h-11 w-full min-w-0 rounded-md border border-stone-200 bg-shell px-3 text-sm outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 sm:w-32 dark:border-white/10 dark:bg-[#211d25] dark:text-night-copy" onChange={(event) => changeTranslationConcurrency(Number(event.target.value))} value={translationConcurrency}>
                        {translationConcurrencyOptions.map((option) => <option key={option} value={option}>{option} 路</option>)}
                      </select>
                    ) : (
                      <div aria-label="本次精翻并发请求数" className="grid min-h-10 w-full min-w-0 overflow-hidden rounded-md border border-stone-200 sm:w-80 dark:border-white/10" role="group" style={{ gridTemplateColumns: `repeat(${translationConcurrencyLimit}, minmax(0, 1fr))` }}>
                        {translationConcurrencyOptions.map((option) => (
                          <button
                            aria-pressed={translationConcurrency === option}
                            className={`border-r border-stone-200 text-sm font-medium transition last:border-r-0 dark:border-white/10 ${translationConcurrency === option ? 'bg-accent text-white' : 'text-stone-600 hover:bg-stone-50 dark:text-night-soft dark:hover:bg-white/[0.05]'}`}
                            key={option}
                            onClick={() => changeTranslationConcurrency(option)}
                            type="button"
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-stone-400">
                    {selectedModelOption
                      ? `${selectedModelOption.display_name} 最多 ${translationConcurrencyLimit} 路，可在设置页调整该模型的并发上限。`
                      : '选择模型后显示它的并发上限。'}
                  </p>
                </div>
              )}
            </div>
            {translationError && <p className="mt-4 text-sm text-red-600 dark:text-red-300">{translationError}</p>}
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-stone-400">
                {queueingTranslationCount > 0
                  ? `正在加入 ${queueingTranslationCount} 本，可以继续粘贴下一个链接。`
                  : '任务在服务器后台运行，完成或失败都会进入通知。'}
              </p>
              <Button
                // The preview is only a courtesy: the server resolves the
                // catalogue itself, so waiting on the lookup just to enable the
                // button stalled queueing one work after another.
                disabled={isClearingTasks || isLoadingTranslationDefaults || isLoadingTranslationModels || Boolean(translationDefaultsError || translationModelsError) || !selectedModelOption?.available || !looksLikeSupportedSourceLink(translationUrl)}
                icon={queueingTranslationCount > 0 ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                onClick={() => void handleStartTranslation()}
              >
                开始整本精翻
              </Button>
            </div>
          </section>
        ) : (
          <form className="mt-6 grid gap-5" onSubmit={(event) => void handleManualSubmit(event)}>
            <div className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
              <label className="inline-flex items-center gap-2" htmlFor="manual-source-url"><Link2 className="h-4 w-4 text-accent" />作品链接 <span className="font-normal text-stone-400">可留空</span></label>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                <input
                  className="min-h-11 min-w-0 w-full flex-1 rounded-md border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                  disabled={isUploading || isLookingUpSource}
                  id="manual-source-url"
                  maxLength={1000}
                  onChange={(event) => setManualDraft((draft) => updateManualBookDraft(draft, { ...draft, sourceUrl: event.target.value }))}
                  onPaste={(event) => {
                    const pastedUrl = event.clipboardData.getData('text').trim();
                    if (looksLikeSupportedSourceLink(pastedUrl)) {
                      void handleSourceLookup(pastedUrl);
                    }
                  }}
                  inputMode="url"
                  placeholder="Kakuyomu、成为小说家吧、ハーメルン或 pixiv"
                  type="text"
                  value={manualDraft.sourceUrl}
                />
                <Button
                  className="shrink-0 sm:min-w-[120px]"
                  disabled={isUploading || isLookingUpSource || !manualDraft.sourceUrl.trim()}
                  icon={isLookingUpSource ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  onClick={() => void handleSourceLookup()}
                  variant="secondary"
                >
                  {isLookingUpSource ? '读取中...' : '读取信息'}
                </Button>
              </div>
              {sourceLookupMessage && <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400">{sourceLookupMessage}</span>}
              {sourceLookupError && <span className="text-xs font-normal text-red-500 dark:text-red-400">{sourceLookupError}</span>}
            </div>
            <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
              <span className="flex items-center justify-between gap-3">
                <span>文章正文</span>
                <span className="text-xs font-normal tabular-nums text-stone-400">{manualDraft.content.trim().length.toLocaleString()} 字</span>
              </span>
              <textarea
                className="min-h-[min(48dvh,420px)] min-w-0 w-full resize-y rounded-md border border-stone-200 bg-shell px-4 py-3 font-display text-[16px] leading-8 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                disabled={isUploading}
                onChange={(event) => setManualDraft((draft) => updateManualBookDraft(draft, { ...draft, content: event.target.value }))}
                placeholder="直接粘贴文章或翻译好的正文"
                value={manualDraft.content}
              />
            </label>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
                <span>作品名 <span className="font-normal text-stone-400">可留空</span></span>
                <input
                  className="min-h-11 min-w-0 w-full rounded-md border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                  disabled={isUploading}
                  maxLength={255}
                  onChange={(event) => setManualDraft((draft) => updateManualBookDraft(draft, { ...draft, title: event.target.value }))}
                  placeholder="留空则使用正文第一行"
                  value={manualDraft.title}
                />
              </label>
              <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
                <span>作者 <span className="font-normal text-stone-400">可留空</span></span>
                <input
                  className="min-h-11 min-w-0 w-full rounded-md border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                  disabled={isUploading}
                  maxLength={255}
                  onChange={(event) => setManualDraft((draft) => updateManualBookDraft(draft, { ...draft, author: event.target.value }))}
                  placeholder="未知作者"
                  value={manualDraft.author}
                />
              </label>
            </div>
            <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
              <span>标签 <span className="font-normal text-stone-400">可留空</span></span>
              <input
                className="min-h-11 min-w-0 w-full rounded-md border border-stone-200 bg-shell px-4 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                disabled={isUploading}
                onChange={(event) => setManualDraft((draft) => updateManualBookDraft(draft, { ...draft, tags: event.target.value }))}
                placeholder="多个标签用逗号分隔"
                value={manualDraft.tags}
              />
            </label>
            <div className="grid min-w-0 gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
              <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
                连载状态
                <select
                  className="min-h-11 min-w-0 w-full rounded-md border border-stone-200 bg-shell px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-[#211a26]"
                  disabled={isUploading}
                  onChange={(event) => setManualDraft((draft) => updateManualBookDraft(draft, { ...draft, publicationStatus: event.target.value === 'ongoing' ? 'ongoing' : 'completed' }))}
                  value={manualDraft.publicationStatus}
                >
                  <option value="ongoing">连载中</option>
                  <option value="completed">已完结</option>
                </select>
              </label>
              <label className="grid min-w-0 gap-2 text-sm font-medium text-stone-700 dark:text-night-copy">
                <span>简介 <span className="font-normal text-stone-400">可留空</span></span>
                <textarea
                  className="min-h-28 min-w-0 w-full resize-y rounded-md border border-stone-200 bg-shell px-4 py-3 text-sm leading-6 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-white/10 dark:bg-white/[0.04]"
                  disabled={isUploading}
                  maxLength={5000}
                  onChange={(event) => setManualDraft((draft) => updateManualBookDraft(draft, { ...draft, description: event.target.value }))}
                  placeholder="作品简介"
                  value={manualDraft.description}
                />
              </label>
            </div>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1 text-xs leading-relaxed">
                {manualDraftStorageIssue
                  ? <ManualDraftStorageStatus disabled={isUploading} hasConfirmedUpload={Boolean(manualSuccessMessage)} hasNewContent={Boolean(manualDraft.content.trim())} issue={manualDraftStorageIssue} onRetry={retryManualDraftPersistence} />
                  : <p className="text-stone-500 dark:text-stone-400">{hasRestoredManualDraft ? '已恢复上次未提交的草稿；修改后会继续自动保存在此设备。' : '输入正文后会自动保存在此设备；保存后可继续追加章节。'}</p>}
              </div>
              <Button disabled={isClearingTasks || isUploading || !manualDraft.content.trim()} icon={<Send className="h-4 w-4" />} type="submit">
                {isUploading ? '正在保存...' : '保存到书架'}
              </Button>
            </div>
          </form>
        )}
        {!isTranslationView && uploadMode !== 'manual' && manualDraftStorageIssue && <div className="mt-4">
          <ManualDraftStorageStatus disabled={isUploading} hasConfirmedUpload={Boolean(manualSuccessMessage)} hasNewContent={Boolean(manualDraft.content.trim())} issue={manualDraftStorageIssue} onOpenDraft={() => setUploadMode('manual')} onRetry={retryManualDraftPersistence} />
        </div>}
        {manualSuccessMessage && <p className="mt-4 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">{manualSuccessMessage}</p>}
        </div>
      </FormContainer>
      {errorMessage && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-300">{errorMessage}</p>}
      <Panel>
        <div aria-busy={isClearingTasks} aria-label={isTranslationView ? "翻译记录" : "上传任务"} className=" focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:focus-visible:outline-peach" onFocusCapture={rememberTaskFocus} onPointerDownCapture={rememberTaskFocus} ref={taskPanelRef} role="region" tabIndex={-1}>
        <SectionHeader
          action={
            <Button
              data-task-focus-control="clear"
              disabled={
                isClearingTasks || isUploading || translationActionJobIds.size > 0 || queueingTranslationCount > 0
                || (!tasks.some((task) => task.status === 'ready' || task.status === 'failed')
                && !translationJobs.some((job) => job.status === 'ready' || job.status === 'failed' || job.status === 'rejected')
                )
              }
              icon={isClearingTasks ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              onClick={() => void handleClearCompletedTasks()}
              variant="secondary"
            >
              {isClearingTasks ? '清理中...' : '清理记录'}
            </Button>
          }
          title={isTranslationView ? "翻译记录" : "上传任务"}
        />
        <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">{isTranslationView ? '清理已完成、已拒绝和失败的记录，保留图书与待审译稿。' : '清理已完成和失败的记录，书架中的图书会保留。'}</p>
        <div className="mt-3">
          {!isTranslationView && <TaskListReadStatus disabled={isClearingTasks} label="上传任务" onRetry={retryUploadTaskRead} state={uploadTaskReadState} />}
          {isTranslationView && <TaskListReadStatus disabled={isClearingTasks} label="翻译任务" onRetry={retryTranslationTaskRead} state={translationTaskReadState} />}
          {isTranslationView && <><TranslationSubmissionList
            disabled={isClearingTasks}
            onRemove={(id) => translationSubmissionQueue.remove(id)}
            onRetry={(id) => { if (!clearTasksControllerRef.current) void translationSubmissionQueue.retry(id); }}
            storageWarning={translationSubmissionWarning}
            submissions={translationSubmissions}
          />
          <TranslationTaskList
            actionErrors={translationActionErrors}
            busyJobIds={translationActionJobIds}
            disabled={isClearingTasks}
            jobs={translationJobs}
            modelOptions={translationModelOptions}
            onConcurrencyChange={(jobId, value) => void updateTranslationJob(jobId, (signal) => updateWholeBookTranslationConcurrency(jobId, value, signal), '并发调整失败')}
            onDelete={(job) => void handleDeleteTranslation(job)}
            onModelChange={(jobId, model, channelId) => void updateTranslationJob(jobId, (signal) => updateWholeBookTranslationModel(jobId, model, channelId, signal), '更换渠道失败')}
            onPause={(jobId) => void updateTranslationJob(jobId, (signal) => pauseWholeBookTranslation(jobId, signal), '暂停翻译失败')}
            onResume={(jobId) => void updateTranslationJob(jobId, (signal) => resumeWholeBookTranslation(jobId, signal), '继续翻译失败')}
            onRetry={(jobId) => void handleRetryTranslation(jobId)}
          /></>}
          {!isTranslationView && tasks.length > 0 && <UploadTaskList canCancelTask={(task) => isLocalUploadTask(task) && abortControllersRef.current.get(task.id)?.signal.aborted === false} canRetryTask={(task) => Boolean(task.bookId) || uploadAttemptsRef.current.has(task.id)} onCancel={handleCancelTask} onRetry={isClearingTasks ? undefined : handleRetryTask} tasks={tasks} />}
          {(isTranslationView
            ? translationJobs.length === 0 && translationSubmissions.length === 0 && translationTaskReadState.hasLoaded && !translationTaskReadState.error
            : tasks.length === 0 && uploadTaskReadState.hasLoaded && !uploadTaskReadState.error)
            && <p className="py-8 text-center text-sm text-stone-500 dark:text-stone-400">{isTranslationView ? '暂无翻译任务，展开上方「新建翻译」粘贴作品链接。' : '暂无上传任务。'}</p>}
        </div>
        </div>
      </Panel>
    </div>
  );
}

function hasActiveUploadTask(tasks: UploadTask[]): boolean {
  return tasks.some((task) => task.status === 'queued' || task.status === 'uploading' || task.status === 'processing');
}

function isLocalUploadTask(task: UploadTask): boolean {
  return task.id.startsWith('local-');
}

function mergeUploadTasks(primaryTasks: UploadTask[], secondaryTasks: UploadTask[]): UploadTask[] {
  const seenTaskIds = new Set<string>();
  const mergedTasks: UploadTask[] = [];

  for (const task of [...primaryTasks, ...secondaryTasks]) {
    if (!seenTaskIds.has(task.id)) {
      mergedTasks.push(task);
      seenTaskIds.add(task.id);
    }
  }

  return mergedTasks;
}

function smoothBackendTaskProgress(backendTask: UploadTask, currentTasks: UploadTask[]): UploadTask {
  if (backendTask.status !== 'processing') {
    return backendTask;
  }

  const visibleTask = currentTasks.find((task) => task.id === backendTask.id || task.fileName === backendTask.fileName);
  if (!visibleTask) {
    return backendTask;
  }

  return { ...backendTask, progress: Math.max(backendTask.progress, visibleTask.progress) };
}

function taskListReadError(error: unknown): string {
  return error instanceof TypeError ? '网络连接中断，请检查网络后重试。' : error instanceof Error ? error.message : '请稍后重试。';
}
