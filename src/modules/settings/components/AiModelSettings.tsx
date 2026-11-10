import { AudioLines, Check, ChevronDown, Eye, EyeOff, Gauge, KeyRound, ListPlus, LoaderCircle, MessageSquareText, PlugZap, Save, Server, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useSession } from '../../../app/SessionContext';
import { cn } from '../../../shared/utils/cn';
import { clearJapaneseAiTranslationCache } from '../../japanese/services/japaneseAiTranslationService';
import { reconcileSubmittedFields } from '../../../shared/utils/reconcileSubmittedFields';
import { isAbortError } from '../../../shared/utils/abortError';
import { useFocusOwnership } from '../../../shared/hooks/useFocusOwnership';
import { subscribeAiConfigurationChanges } from '../services/aiConfigurationEvents';
import { focusSettingsField, getProviderValidationIssues, type SettingsValidationIssue } from '../services/settingsValidation';
import {
  getAiModelSettings,
  getAiModelSettingsChanges,
  removeAiModelSettings,
  saveAiModelSettings,
  testAiProvider,
  type AiModelSettings as AiModelSettingsValue,
} from '../services/aiModelSettingsService';

type ProviderKind = 'translation' | 'audiobook';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type RequestState = 'idle' | 'loading' | 'success' | 'error';

type ProviderDraft = {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
};

type ProviderUiState = {
  fetch: RequestState;
  test: RequestState;
  error?: string;
};

const emptyDraft: ProviderDraft = { apiKey: '', baseUrl: '', model: '', voice: '' };
const emptyProviderUi: ProviderUiState = { fetch: 'idle', test: 'idle' };

function translationDraft(settings: AiModelSettingsValue): ProviderDraft {
  return { apiKey: '', baseUrl: settings.providerBaseUrl, model: settings.translationModel, voice: '' };
}

function audiobookDraft(settings: AiModelSettingsValue): ProviderDraft {
  return { apiKey: '', baseUrl: settings.audiobookProviderBaseUrl, model: settings.audiobookTtsModel, voice: settings.audiobookTtsVoice };
}

export function AiModelSettings() {
  const { session } = useSession();
  const [settings, setSettings] = useState<AiModelSettingsValue | null>(null);
  const [translation, setTranslation] = useState<ProviderDraft>(emptyDraft);
  const [translationPrompt, setTranslationPrompt] = useState('');
  const [translationConcurrency, setTranslationConcurrency] = useState(2);
  const [audiobook, setAudiobook] = useState<ProviderDraft>(emptyDraft);
  const [models, setModels] = useState<Record<ProviderKind, string[]>>({ audiobook: [], translation: [] });
  const [providerUi, setProviderUi] = useState<Record<ProviderKind, ProviderUiState>>({
    audiobook: emptyProviderUi,
    translation: emptyProviderUi,
  });
  const [loadError, setLoadError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const [saveAction, setSaveAction] = useState<'save' | 'remove'>('save');
  const [reloadKey, setReloadKey] = useState(0);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [refreshError, setRefreshError] = useState('');
  const acknowledgedRef = useRef<AiModelSettingsValue | null>(null);
  const refreshSettingsRef = useRef<(() => void) | null>(null);
  const refreshAfterSaveRef = useRef(false);
  const backgroundReadRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const providerRequestRef = useRef<Record<ProviderKind, { controller: AbortController; id: number } | null>>({ audiobook: null, translation: null });
  const providerRequestIdRef = useRef<Record<ProviderKind, number>>({ audiobook: 0, translation: 0 });
  const saveControllerRef = useRef<AbortController | null>(null);
  const saveStateTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const ownsFocus = useFocusOwnership();
  const actionFocusRef = useRef<HTMLElement | null>(null);
  const returnActionFocusRef = useRef(false);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    const controller = new AbortController();
    let refreshController: AbortController | null = null;
    const requests = providerRequestRef.current;
    saveControllerRef.current?.abort();
    saveControllerRef.current = null;
    setSettings(null);
    setTouchedFields(new Set());
    acknowledgedRef.current = null;
    refreshAfterSaveRef.current = false;
    setRefreshError('');
    setLoadError('');
    setSaveState('idle');
    setSaveError('');
    setModels({ audiobook: [], translation: [] });
    setProviderUi({ audiobook: emptyProviderUi, translation: emptyProviderUi });
    const refresh = () => {
      if (saveControllerRef.current) { refreshAfterSaveRef.current = true; return; }
      refreshController?.abort();
      const request = new AbortController();
      refreshController = request;
      backgroundReadRef.current = request;
      if (!acknowledgedRef.current) controller.abort();
      setRefreshError('');
      void getAiModelSettings(request.signal).then((next) => {
        if (!active || request.signal.aborted) return;
        if (saveControllerRef.current) { refreshAfterSaveRef.current = true; return; }
        const previous = acknowledgedRef.current;
        if (previous) {
          setTranslation((current) => reconcileSubmittedFields(current, translationDraft(previous), translationDraft(next)));
          setAudiobook((current) => reconcileSubmittedFields(current, audiobookDraft(previous), audiobookDraft(next)));
          setTranslationPrompt((current) => current === previous.translationPrompt ? next.translationPrompt : current);
          setTranslationConcurrency((current) => current === previous.translationConcurrency ? next.translationConcurrency : current);
        } else {
          setTranslation(translationDraft(next)); setAudiobook(audiobookDraft(next));
          setTranslationPrompt(next.translationPrompt); setTranslationConcurrency(next.translationConcurrency);
        }
        acknowledgedRef.current = next;
        setSettings(next); setLoadError('');
        for (const kind of ['translation', 'audiobook'] as const) {
          providerRequestRef.current[kind]?.controller.abort();
          providerRequestRef.current[kind] = null;
          providerRequestIdRef.current[kind] += 1;
        }
        setProviderUi({ audiobook: emptyProviderUi, translation: emptyProviderUi });
        setModels({ audiobook: [], translation: [] });
        clearJapaneseAiTranslationCache();
      }).catch((error: unknown) => {
        if (active && !request.signal.aborted && !isAbortError(error)) {
          const message = error instanceof Error ? error.message : 'AI 设置同步失败';
          setRefreshError(message);
          if (!acknowledgedRef.current) setLoadError(message);
        }
      });
    };
    refreshSettingsRef.current = refresh;
    const unsubscribe = subscribeAiConfigurationChanges('channel', refresh);
    void getAiModelSettings(controller.signal)
      .then((nextSettings) => {
        if (!active) return;
        // A newer channel-triggered read owns the current account snapshot.
        if (refreshController) return;
        acknowledgedRef.current = nextSettings;
        setSettings(nextSettings);
        setTranslation({ apiKey: '', baseUrl: nextSettings.providerBaseUrl, model: nextSettings.translationModel, voice: '' });
        setTranslationPrompt(nextSettings.translationPrompt);
        setTranslationConcurrency(nextSettings.translationConcurrency);
        setAudiobook({
          apiKey: '',
          baseUrl: nextSettings.audiobookProviderBaseUrl,
          model: nextSettings.audiobookTtsModel,
          voice: nextSettings.audiobookTtsVoice,
        });
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted && !refreshController && !isAbortError(error)) setLoadError(error instanceof Error ? error.message : '第三方 AI 设置读取失败');
      });
    return () => {
      active = false;
      mountedRef.current = false;
      controller.abort();
      refreshController?.abort();
      backgroundReadRef.current = null;
      unsubscribe();
      refreshSettingsRef.current = null;
      requests.audiobook?.controller.abort();
      requests.translation?.controller.abort();
      requests.audiobook = null;
      requests.translation = null;
      saveControllerRef.current?.abort();
      saveControllerRef.current = null;
      if (saveStateTimerRef.current !== null) window.clearTimeout(saveStateTimerRef.current);
      saveStateTimerRef.current = null;
    };
  }, [session?.id, reloadKey]);

  const translationKeyAvailable = Boolean(translation.apiKey.trim() || settings?.apiKeyConfigured);
  const audiobookKeyAvailable = Boolean(audiobook.apiKey.trim() || settings?.audiobookApiKeyConfigured);
  const validationIssues = [...getProviderValidationIssues('translation', translation, Boolean(settings?.apiKeyConfigured)), ...getProviderValidationIssues('audiobook', audiobook, Boolean(settings?.audiobookApiKeyConfigured))];
  const hasChanges = Boolean(settings && (
    translation.baseUrl.trim() !== settings.providerBaseUrl
    || translation.model.trim() !== settings.translationModel
    || translation.apiKey.trim()
    || translationPrompt.trim() !== settings.translationPrompt
    || translationConcurrency !== settings.translationConcurrency
    || audiobook.baseUrl.trim() !== settings.audiobookProviderBaseUrl
    || audiobook.model.trim() !== settings.audiobookTtsModel
    || audiobook.voice.trim() !== settings.audiobookTtsVoice
    || audiobook.apiKey.trim()
  ));
  const canSave = Boolean(
    hasChanges
    && saveState !== 'saving',
  );
  useLayoutEffect(() => {
    if (!returnActionFocusRef.current || saveState === 'saving') return;
    returnActionFocusRef.current = false;
    const previous = actionFocusRef.current;
    actionFocusRef.current = null;
    if (!previous || !ownsFocus(previous)) return;
    const target = previous.isConnected && !previous.matches(':disabled') ? previous : formRef.current;
    target?.focus({ preventScroll: true });
  }, [ownsFocus, saveState]);

  const rememberActionFocus = () => {
    actionFocusRef.current = document.activeElement instanceof HTMLElement && formRef.current?.contains(document.activeElement) ? document.activeElement : null;
    returnActionFocusRef.current = false;
  };
  const acknowledgeAction = (controller: AbortController) => {
    setSaveState('saved');
    saveStateTimerRef.current = window.setTimeout(() => {
      saveStateTimerRef.current = null;
      if (mountedRef.current && !controller.signal.aborted) setSaveState('idle');
    }, 1800);
  };
  const showValidation = (issues: SettingsValidationIssue[]) => {
    setTouchedFields((current) => new Set([...current, ...issues.map((issue) => issue.field)]));
    if (issues.length) focusSettingsField(formRef.current, issues[0].field);
  };

  const updateProviderUi = (kind: ProviderKind, patch: Partial<ProviderUiState>) => {
    setProviderUi((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  };

  const markEdited = (kind: ProviderKind, providerChanged = false) => {
    providerRequestRef.current[kind]?.controller.abort();
    providerRequestRef.current[kind] = null;
    providerRequestIdRef.current[kind] += 1;
    setSaveState((current) => current === 'saving' ? current : 'idle');
    setSaveError('');
    updateProviderUi(kind, { fetch: 'idle', test: 'idle', error: '' });
    if (providerChanged) setModels((current) => ({ ...current, [kind]: [] }));
  };

  const runProviderRequest = async (kind: ProviderKind, fetchModels: boolean) => {
    const draft = kind === 'translation' ? translation : audiobook;
    const keyAvailable = kind === 'translation' ? translationKeyAvailable : audiobookKeyAvailable;
    if (saveControllerRef.current || providerRequestRef.current[kind] || !draft.baseUrl.trim() || !keyAvailable) return;
    const connectionIssues = getProviderValidationIssues(kind, draft, kind === 'translation' ? Boolean(settings?.apiKeyConfigured) : Boolean(settings?.audiobookApiKeyConfigured), true);
    if (connectionIssues.length) { showValidation(connectionIssues); return; }
    const controller = new AbortController();
    const request = { controller, id: providerRequestIdRef.current[kind] + 1 };
    providerRequestIdRef.current[kind] = request.id;
    providerRequestRef.current[kind] = request;
    updateProviderUi(kind, { fetch: fetchModels ? 'loading' : 'idle', test: fetchModels ? 'idle' : 'loading', error: '' });
    try {
      const result = await testAiProvider({ apiKey: draft.apiKey, credentialScope: kind, providerBaseUrl: draft.baseUrl, signal: controller.signal });
      if (!mountedRef.current || providerRequestRef.current[kind]?.id !== request.id || controller.signal.aborted) return;
      if (!result.available) throw new Error('服务商暂不可用，请检查地址、密钥和服务状态');
      if (fetchModels) {
        setModels((current) => ({ ...current, [kind]: result.models }));
        updateProviderUi(kind, { fetch: 'success' });
      } else {
        updateProviderUi(kind, { test: 'success' });
      }
    } catch (error: unknown) {
      if (isAbortError(error) || !mountedRef.current || providerRequestRef.current[kind]?.id !== request.id) return;
      if (fetchModels) {
        setModels((current) => ({ ...current, [kind]: [] }));
        updateProviderUi(kind, { fetch: 'error', error: error instanceof Error ? error.message : '模型获取失败，仍可手动填写' });
      } else {
        updateProviderUi(kind, { test: 'error', error: error instanceof Error ? error.message : '连接失败，请检查地址、密钥和服务商状态' });
      }
    } finally {
      if (providerRequestRef.current[kind]?.id === request.id) providerRequestRef.current[kind] = null;
    }
  };

  const save = async () => {
    if (!canSave || saveControllerRef.current) return;
    if (validationIssues.length) { showValidation(validationIssues); return; }
    if (saveStateTimerRef.current !== null) window.clearTimeout(saveStateTimerRef.current);
    saveStateTimerRef.current = null;
    const controller = new AbortController();
    saveControllerRef.current = controller;
    backgroundReadRef.current?.abort();
    providerRequestRef.current.audiobook?.controller.abort();
    providerRequestRef.current.translation?.controller.abort();
    providerRequestRef.current.audiobook = null;
    providerRequestRef.current.translation = null;
    providerRequestIdRef.current.audiobook += 1;
    providerRequestIdRef.current.translation += 1;
    setProviderUi({ audiobook: emptyProviderUi, translation: emptyProviderUi });
    setSaveError('');
    setSaveAction('save');
    rememberActionFocus();
    setSaveState('saving');
    const submitted = { translation, audiobook, translationPrompt, translationConcurrency };
    try {
      const saved = await saveAiModelSettings({ ...getAiModelSettingsChanges({
        apiKey: translation.apiKey,
        audiobookApiKey: audiobook.apiKey,
        audiobookProviderBaseUrl: audiobook.baseUrl,
        audiobookTtsModel: audiobook.model,
        audiobookTtsVoice: audiobook.voice,
        providerBaseUrl: translation.baseUrl,
        translationModel: translation.model,
        translationPrompt,
        translationConcurrency,
      }, settings!), signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      setSettings(saved);
      acknowledgedRef.current = saved;
      setTranslation((current) => reconcileSubmittedFields(current, submitted.translation, { apiKey: '', baseUrl: saved.providerBaseUrl, model: saved.translationModel, voice: '' }));
      setTranslationPrompt((current) => current === submitted.translationPrompt ? saved.translationPrompt : current);
      setTranslationConcurrency((current) => current === submitted.translationConcurrency ? saved.translationConcurrency : current);
      setAudiobook((current) => reconcileSubmittedFields(current, submitted.audiobook, {
        apiKey: '', baseUrl: saved.audiobookProviderBaseUrl, model: saved.audiobookTtsModel, voice: saved.audiobookTtsVoice,
      }));
      clearJapaneseAiTranslationCache();
      acknowledgeAction(controller);
    } catch (error: unknown) {
      if (mountedRef.current && !controller.signal.aborted) {
        setSaveState('error');
        setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试');
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) returnActionFocusRef.current = true;
      if (saveControllerRef.current === controller) saveControllerRef.current = null;
      if (mountedRef.current && refreshAfterSaveRef.current) { refreshAfterSaveRef.current = false; refreshSettingsRef.current?.(); }
    }
  };

  const remove = async () => {
    if (saveControllerRef.current) return;
    if (!window.confirm('移除日文翻译、听书配置和关联的默认翻译渠道？\n\n翻译预设会清空，精翻并发恢复为 2。\n其他手动添加的渠道会保留。')) return;
    if (saveStateTimerRef.current !== null) window.clearTimeout(saveStateTimerRef.current);
    saveStateTimerRef.current = null;
    const controller = new AbortController();
    saveControllerRef.current = controller;
    backgroundReadRef.current?.abort();
    providerRequestRef.current.audiobook?.controller.abort();
    providerRequestRef.current.translation?.controller.abort();
    providerRequestRef.current.audiobook = null;
    providerRequestRef.current.translation = null;
    providerRequestIdRef.current.audiobook += 1;
    providerRequestIdRef.current.translation += 1;
    setProviderUi({ audiobook: emptyProviderUi, translation: emptyProviderUi });
    setSaveError('');
    setSaveAction('remove');
    rememberActionFocus();
    setSaveState('saving');
    const submitted = { translation, audiobook, translationPrompt, translationConcurrency };
    try {
      const cleared = await removeAiModelSettings(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setSettings(cleared);
      acknowledgedRef.current = cleared;
      setTranslation((current) => reconcileSubmittedFields(current, submitted.translation, emptyDraft));
      setTranslationPrompt((current) => current === submitted.translationPrompt ? '' : current);
      setTranslationConcurrency((current) => current === submitted.translationConcurrency ? 2 : current);
      setAudiobook((current) => reconcileSubmittedFields(current, submitted.audiobook, emptyDraft));
      setModels({ audiobook: [], translation: [] });
      setProviderUi({ audiobook: emptyProviderUi, translation: emptyProviderUi });
      clearJapaneseAiTranslationCache();
      acknowledgeAction(controller);
    } catch (error: unknown) {
      if (mountedRef.current && !controller.signal.aborted) {
        setSaveState('error');
        setSaveError(error instanceof Error ? error.message : '移除失败，请稍后重试');
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) returnActionFocusRef.current = true;
      if (saveControllerRef.current === controller) saveControllerRef.current = null;
      if (mountedRef.current && refreshAfterSaveRef.current) { refreshAfterSaveRef.current = false; refreshSettingsRef.current?.(); }
    }
  };

  if (loadError) return <div className="flex flex-wrap items-center gap-3 py-5" role="alert"><p className="min-w-0 max-w-full break-words text-sm text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{loadError}</p><button className="min-h-11 px-3 text-sm font-medium text-accent" onClick={() => setReloadKey((current) => current + 1)} type="button">重试读取 AI 设置</button></div>;
  if (!settings) return <div className="flex min-h-28 items-center gap-2 py-5 text-sm text-stone-500"><LoaderCircle className="h-4 w-4 animate-spin" />正在读取第三方 AI 设置</div>;

  return (
    <form aria-busy={saveState === 'saving'} aria-label="第三方 AI 设置" className="border-t border-ink/[0.07] py-6 focus:outline-none lg:py-4 dark:border-white/10" noValidate ref={formRef} tabIndex={-1} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-stone-900 dark:text-night-ink">第三方 AI</h2>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">翻译与听书可使用不同服务商，API Key 分别加密保存到你的账号</p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-1">
          {(settings.apiKeyConfigured || settings.audiobookApiKeyConfigured) && (
            <button className="inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap px-3 text-xs text-stone-500 transition hover:text-red-600" disabled={saveState === 'saving'} onClick={() => void remove()} type="button">
              <Trash2 className="h-3.5 w-3.5" />移除配置
            </button>
          )}
          <button className="inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-40" disabled={!canSave} type="submit">
            {saveState === 'saving' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : saveState === 'saved' && !hasChanges ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {saveState === 'saving' ? saveAction === 'remove' ? '移除中…' : '保存中' : saveState === 'saved' && !hasChanges ? saveAction === 'remove' ? '已移除' : '已保存' : '保存设置'}
          </button>
        </div>
      </div>

      {saveState === 'error' && <p role="alert" className="mt-3 break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{saveError}</p>}
      {saveState === 'saved' && <p role="status" className="mt-3 text-xs text-stone-500 dark:text-stone-400">{saveAction === 'remove' ? '已移除已保存的配置。' : '本次设置已保存。'}{hasChanges ? '新输入的修改尚未保存。' : ''}</p>}
      {refreshError && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-red-600 dark:text-red-300" role="alert"><span className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">{refreshError}；未保存的修改已保留。</span><button className="min-h-10 px-2 font-medium text-accent" onClick={() => refreshSettingsRef.current?.()} type="button">重试同步 AI 设置</button></div>}
      {hasChanges && <p aria-live="polite" className="mt-3 text-xs text-stone-500 dark:text-stone-400">{saveState === 'saving' ? saveAction === 'remove' ? '正在移除已保存的接入；新输入的修改会保留。' : '正在保存本次提交；继续输入的新修改会保留。' : '有未保存的修改'}</p>}

      <div className="mt-6 lg:mt-4 divide-y divide-ink/[0.07] dark:divide-white/10">
        <ProviderEditor
          errors={Object.fromEntries(validationIssues.filter((issue) => touchedFields.has(issue.field)).map((issue) => [issue.field, issue.message]))}
          description="用于日文阅读；地址与密钥会同步到关联的默认翻译渠道"
          busy={saveState === 'saving'}
          key={`translation-${session?.id}`}
          draft={translation}
          icon={Sparkles}
          keyConfigured={settings.apiKeyConfigured}
          kind="translation"
          models={models.translation}
          onChange={(draft, providerChanged) => { setTranslation(draft); markEdited('translation', providerChanged); }}
          onFetch={() => void runProviderRequest('translation', true)}
          onTest={() => void runProviderRequest('translation', false)}
          title="日文翻译渠道"
          ui={providerUi.translation}
        />
        <div className="grid gap-4 py-5 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-8 lg:gap-5 lg:py-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-night-ink">
              <MessageSquareText className="h-4 w-4 text-accent" />翻译预设
            </h3>
            <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">用于整本翻译、连载更新及阅读器内的日文翻译。保存后用于新请求，已创建的整本任务沿用原预设。</p>
          </div>
          <label className="block min-w-0">
            <textarea
              className="min-h-32 w-full resize-y border-b border-ink/15 bg-transparent px-1 py-2 text-sm leading-6 text-stone-800 outline-none transition placeholder:text-stone-400 focus:border-accent dark:border-white/15 dark:text-night-ink"
              aria-label="翻译预设"
              maxLength={6000}
              onChange={(event) => { setTranslationPrompt(event.target.value); setSaveState((current) => current === 'saving' ? current : 'idle'); setSaveError(''); }}
              placeholder="例如：雪乃固定译为雪乃；女主对前辈保持敬语距离；对话自然口语化；不要弱化亲密场景。"
              value={translationPrompt}
            />
            <span className="mt-1 block text-right text-[11px] tabular-nums text-stone-400">{translationPrompt.length.toLocaleString()} / 6,000</span>
          </label>
        </div>
        <div className="grid gap-4 py-5 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-8 lg:gap-5 lg:py-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-night-ink">
              <Gauge className="h-4 w-4 text-accent" />精翻并发
            </h3>
            <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">新翻译任务的默认并发数，已有任务可在任务卡片中单独调整。</p>
          </div>
          <ConcurrencyControl
            disabled={saveState === 'saving'}
            onChange={(value) => { setTranslationConcurrency(value); setSaveState((current) => current === 'saving' ? current : 'idle'); setSaveError(''); }}
            value={translationConcurrency}
          />
        </div>
        <ProviderEditor
          errors={Object.fromEntries(validationIssues.filter((issue) => touchedFields.has(issue.field)).map((issue) => [issue.field, issue.message]))}
          description={settings.audiobookApiKeyConfigured
            ? '当前使用自定义语音渠道；移除后自动切回免费默认语音'
            : '未配置时使用微软 Edge 在线免费语音：中文晓晓、日文七海'}
          busy={saveState === 'saving'}
          key={`audiobook-${session?.id}`}
          draft={audiobook}
          icon={AudioLines}
          keyConfigured={settings.audiobookApiKeyConfigured}
          kind="audiobook"
          models={models.audiobook}
          onChange={(draft, providerChanged) => { setAudiobook(draft); markEdited('audiobook', providerChanged); }}
          onFetch={() => void runProviderRequest('audiobook', true)}
          onTest={() => void runProviderRequest('audiobook', false)}
          title="听书语音渠道（可选）"
          ui={providerUi.audiobook}
        />
      </div>
    </form>
  );
}

function ConcurrencyControl({ disabled = false, onChange, value }: {
  disabled?: boolean;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <div aria-label="精翻并发请求数" className="grid h-11 w-full max-w-xs grid-cols-4 overflow-hidden rounded-md border border-ink/10 dark:border-white/15" role="group">
      {[1, 2, 3, 4].map((option) => (
        <button
          aria-pressed={value === option}
          className={cn(
            'border-r border-ink/10 text-sm font-medium transition last:border-r-0 dark:border-white/15',
            value === option ? 'bg-accent text-white' : 'bg-transparent text-stone-600 hover:bg-ink/[0.04] dark:text-night-soft dark:hover:bg-white/[0.06]',
          )}
          disabled={disabled}
          key={option}
          onClick={() => onChange(option)}
          type="button"
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function ProviderEditor({ busy, description, draft, errors, icon: Icon, keyConfigured, kind, models, onChange, onFetch, onTest, title, ui }: {
  busy: boolean;
  description: string;
  draft: ProviderDraft;
  errors: Record<string, string>;
  icon: typeof Sparkles;
  keyConfigured: boolean;
  kind: ProviderKind;
  models: string[];
  onChange: (draft: ProviderDraft, providerChanged?: boolean) => void;
  onFetch: () => void;
  onTest: () => void;
  title: string;
  ui: ProviderUiState;
}) {
  const [showApiKey, setShowApiKey] = useState(false);
  const canConnect = Boolean(!busy && draft.baseUrl.trim() && (draft.apiKey.trim() || keyConfigured) && ui.fetch !== 'loading' && ui.test !== 'loading');
  const update = (patch: Partial<ProviderDraft>, providerChanged = false) => onChange({ ...draft, ...patch }, providerChanged);

  return (
    <section className="py-6 first:pt-1 lg:py-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 text-accent" />
        <div>
          <h3 className="text-sm font-semibold text-stone-800 dark:text-night-ink">{title}</h3>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{description}</p>
        </div>
      </div>

      <div className="mt-5 grid gap-x-7 gap-y-5 lg:mt-3 lg:gap-y-3 md:grid-cols-2 lg:grid-cols-3">
        <ModelField error={errors[`${kind}-provider-base-url`]} icon={Server} inputMode="url" label="Base URL" name={`${kind}-provider-base-url`} onChange={(value) => update({ baseUrl: value }, true)} placeholder="https://api.example.com/v1" value={draft.baseUrl} />
        <div className="block">
          <label htmlFor={`${kind}-provider-api-key`} className="flex items-center gap-2 text-xs font-medium text-stone-600 dark:text-night-soft"><KeyRound className="h-4 w-4 text-accent" />API Key</label>
          <span className="relative mt-2 block">
            <input
              autoComplete="off"
              className={fieldClassName}
              maxLength={4096}
              name={`${kind}-provider-api-key`}
              id={`${kind}-provider-api-key`}
              aria-invalid={errors[`${kind}-provider-api-key`] ? true : undefined}
              aria-describedby={errors[`${kind}-provider-api-key`] ? `${kind}-provider-api-key-error` : undefined}
              onChange={(event) => update({ apiKey: event.target.value }, true)}
              placeholder={keyConfigured ? '已保存，留空不会修改' : 'sk-...'}
              spellCheck={false}
              style={showApiKey ? undefined : ({ WebkitTextSecurity: 'disc' } as CSSProperties)}
              type="text"
              value={draft.apiKey}
            />
            <button aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'} className="absolute inset-y-0 right-0 grid w-10 place-items-center text-stone-400 transition hover:text-accent" onClick={() => setShowApiKey((value) => !value)} title={showApiKey ? '隐藏 API Key' : '显示 API Key'} type="button">
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </span>
          {errors[`${kind}-provider-api-key`] && <p className="mt-1 text-xs text-red-600 dark:text-red-300" id={`${kind}-provider-api-key-error`}>{errors[`${kind}-provider-api-key`]}</p>}
        </div>
        <ModelField
          error={errors[`${kind}-model`]}
          icon={kind === 'translation' ? Sparkles : AudioLines}
          label={kind === 'translation' ? '日文翻译模型' : '听书语音模型'}
          models={models}
          name={`${kind}-model`}
          onChange={(value) => update({ model: value })}
          placeholder="手动填写模型名称"
          value={draft.model}
        />
        {kind === 'audiobook' && (
          <ModelField error={errors['audiobook-voice']} icon={AudioLines} label="音色" name="audiobook-voice" onChange={(value) => update({ voice: value })} placeholder="例如 alloy、Chloe；可留空" value={draft.voice} />
        )}
      </div>

      <div className="mt-5 lg:mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-stone-600 transition hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 dark:text-night-soft" disabled={!canConnect} onClick={onTest} type="button">
          {ui.test === 'loading' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
          {ui.test === 'loading' ? '正在连接' : '检测连接'}
        </button>
        <button className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-stone-600 transition hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 dark:text-night-soft" disabled={!canConnect} onClick={onFetch} type="button">
          {ui.fetch === 'loading' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ListPlus className="h-4 w-4" />}
          {ui.fetch === 'loading' ? '正在获取' : '获取模型'}
        </button>
        {ui.test === 'success' && <span role="status" className="text-xs text-emerald-700 dark:text-emerald-300">连接成功</span>}
        {ui.test === 'error' && <span role="alert" className="min-w-0 max-w-full break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{ui.error || '连接失败，请检查地址、密钥和服务商状态'}</span>}
        {ui.fetch === 'success' && <span role="status" className="text-xs text-emerald-700 dark:text-emerald-300">已获取 {models.length} 个模型</span>}
        {ui.fetch === 'error' && <span role="alert" className="min-w-0 max-w-full break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{ui.error || '模型获取失败，仍可手动填写'}</span>}
      </div>
    </section>
  );
}

const fieldClassName = 'h-11 w-full border-0 border-b border-ink/15 bg-transparent px-1 pr-10 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-accent dark:border-white/15 dark:text-night-ink dark:placeholder:text-stone-600';

function ModelField({ error, icon: Icon, inputMode, label, models = [], name, onChange, placeholder, value }: {
  error?: string;
  icon: typeof Sparkles;
  inputMode?: 'url';
  label: string;
  models?: string[];
  name: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <div className={cn('block min-w-0', models.length > 0 && 'self-start')}>
      <label className="block" htmlFor={name}>
        <span className="flex items-center gap-2 text-xs font-medium text-stone-600 dark:text-night-soft"><Icon className="h-4 w-4 text-accent" />{label}</span>
        <input aria-invalid={error ? true : undefined} aria-describedby={error ? `${name}-error` : undefined} autoComplete="off" className={fieldClassName} id={name} inputMode={inputMode} maxLength={inputMode === 'url' ? 500 : 128} name={name} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} spellCheck={false} value={value} />
      </label>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-300" id={`${name}-error`}>{error}</p>}
      {models.length > 0 && (
        <ModelSelectMenu label={label} models={models} onChange={onChange} value={value} />
      )}
    </div>
  );
}

function ModelSelectMenu({ label, models, onChange, value }: {
  label: string;
  models: string[];
  onChange: (value: string) => void;
  value: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = `${label === '日文翻译模型' ? 'translation' : 'audiobook'}-model-options`;

  const open = (fromEnd = false) => {
    const selected = models.indexOf(value);
    setActiveIndex(selected >= 0 ? selected : fromEnd ? models.length - 1 : 0);
    setIsOpen(true);
  };
  const closeAndRestoreFocus = () => {
    triggerRef.current?.focus({ preventScroll: true });
    setIsOpen(false);
  };

  useLayoutEffect(() => {
    if (!isOpen) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      frame = 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const header = document.querySelector('.topbar-shell')?.getBoundingClientRect();
      const navigation = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
      const top = Math.max(viewportTop, header?.height ? header.bottom : viewportTop) + 8;
      const bottom = Math.min(viewportBottom, navigation?.height ? navigation.top : viewportBottom) - 8;
      const bounds = trigger.getBoundingClientRect();
      if (bounds.bottom <= top || bounds.top >= bottom) {
        trigger.focus({ preventScroll: true }); setIsOpen(false); return;
      }
      const above = Math.max(0, bounds.top - top - 4);
      const below = Math.max(0, bottom - bounds.bottom - 4);
      const preferredHeight = Math.min(menu.scrollHeight, 18 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
      const opensAbove = below < preferredHeight && above > below;
      menu.style.top = opensAbove ? 'auto' : 'calc(100% + 4px)';
      menu.style.bottom = opensAbove ? 'calc(100% + 4px)' : 'auto';
      menu.style.maxHeight = `${Math.min(preferredHeight, opensAbove ? above : below)}px`;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && menu.contains(focused)) revealModelOption(menu, focused);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    // Browsing the list must not snap it back to the keyboard-focused option.
    const handleScroll = (event: Event) => { if (event.target !== menu) schedule(); };
    const observer = new ResizeObserver(schedule);
    observer.observe(trigger); observer.observe(menu);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', handleScroll, true);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    update();
    return () => {
      observer.disconnect(); window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', handleScroll, true);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const menu = menuRef.current;
    const option = menu?.querySelectorAll<HTMLButtonElement>('[role="option"]')[activeIndex];
    if (!menu || !option) return;
    option.focus({ preventScroll: true });
    revealModelOption(menu, option);
  }, [activeIndex, isOpen, models]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
    };
  }, [isOpen]);

  return (
    <div className="relative mt-2" ref={rootRef}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false); }}
      onKeyDown={(event) => {
        if (!isOpen) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); closeAndRestoreFocus();
        } else if (event.key === 'Tab') {
          // Let native Tab traversal continue from the opener after removal.
          closeAndRestoreFocus();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          setActiveIndex((current) => event.key === 'Home' ? 0 : event.key === 'End' ? models.length - 1
            : Math.max(0, Math.min(models.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))));
        }
      }}>
      <button
        aria-controls={menuId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`${label}：从已获取的模型中选择`}
        className="flex min-h-10 w-full items-center justify-between gap-3 border-b border-ink/10 px-1 text-left text-xs text-stone-500 outline-none transition hover:text-stone-800 focus:border-accent dark:border-white/10 dark:text-stone-400 dark:hover:text-night-ink"
        onClick={() => { if (isOpen) setIsOpen(false); else open(); }}
        onKeyDown={(event) => {
          if (!isOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault(); open(event.key === 'ArrowUp');
          }
        }}
        ref={triggerRef}
        type="button"
      >
        <span>从已获取的 {models.length} 个模型中选择</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', isOpen && 'rotate-180')} />
      </button>
      {isOpen && (
        <div
          aria-label={`${label}选择列表`}
          className="absolute inset-x-0 top-[calc(100%+4px)] z-50 max-h-72 overflow-y-auto overscroll-contain rounded-md bg-[#fffdfa] py-1 text-stone-700 shadow-[0_16px_42px_rgba(40,32,32,0.18)] ring-1 ring-ink/10 reader-scrollbar dark:bg-[#211a25] dark:text-night-copy dark:shadow-[0_20px_48px_rgba(0,0,0,0.42)] dark:ring-white/10"
          id={menuId}
          ref={menuRef}
          role="listbox"
        >
          {models.map((model) => {
            const isSelected = model === value;
            return (
              <button
                aria-selected={isSelected}
                className={cn(
                  'flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-xs outline-none transition hover:bg-stone-900/[0.045] focus-visible:bg-accent/[0.12] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent dark:hover:bg-white/[0.07]',
                  isSelected && 'bg-accent/[0.09] text-stone-950 dark:bg-accent/[0.14] dark:text-night-ink',
                )}
                key={model}
                onClick={() => {
                  onChange(model);
                  closeAndRestoreFocus();
                }}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span className="min-w-0 flex-1 break-all">{model}</span>
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Scroll only the options, leaving the surrounding settings in place. */
function revealModelOption(menu: HTMLElement, option: HTMLElement) {
  if (option.offsetTop < menu.scrollTop + 4) menu.scrollTop = option.offsetTop - 4;
  else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight - 4) {
    menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight + 4;
  }
}
