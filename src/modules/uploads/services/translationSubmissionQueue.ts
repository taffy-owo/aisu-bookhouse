import { createRequestId } from '../../../shared/utils/requestId';
import {
  createTranslationSubmissionStorage,
  INTERRUPTED_TRANSLATION_SUBMISSION,
  type TranslationSubmission,
  type TranslationSubmissionInput,
} from './translationSubmissionStorage';
import type { WholeBookTranslationJob } from './wholeBookTranslationService';

interface QueueOptions {
  scope: string;
  getAccountScope: () => string;
  create: (input: TranslationSubmissionInput, signal: AbortSignal) => Promise<WholeBookTranslationJob>;
  onCreated: (job: WholeBookTranslationJob) => void;
  storage?: ReturnType<typeof createTranslationSubmissionStorage>;
}

export function createTranslationSubmissionQueue(options: QueueOptions) {
  const storage = options.storage ?? createTranslationSubmissionStorage(options.scope);
  const initial = storage.load();
  let snapshot = { submissions: initial.records.map(interrupted).sort(newestFirst), storageWarning: storage.warning() };
  let active = false;
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  const canAct = () => active && options.getAccountScope() === options.scope;
  const publish = (submissions = snapshot.submissions) => {
    snapshot = { submissions: [...submissions].sort(newestFirst), storageWarning: storage.warning() };
    listeners.forEach((listener) => listener());
  };
  const save = (record: TranslationSubmission) => {
    storage.save(record);
    publish([record, ...snapshot.submissions.filter((item) => item.id !== record.id)]);
  };
  const remove = (id: string) => {
    storage.remove(id);
    publish(snapshot.submissions.filter((item) => item.id !== id));
  };
  const attempt = async (record: TranslationSubmission) => {
    if (!canAct() || controllers.has(record.id)) return;
    // Also guard a second click or equivalent form submission before React renders.
    if (snapshot.submissions.some((item) => item.id !== record.id && controllers.has(item.id) && sameRequest(item, record))) return;
    const controller = new AbortController();
    controllers.set(record.id, controller);
    save({ ...record, status: 'pending', error: '' });
    const isCurrent = () => canAct() && !controller.signal.aborted && controllers.get(record.id) === controller;
    let job: WholeBookTranslationJob;
    try {
      job = await options.create(record, controller.signal);
    } catch (error) {
      if (!isCurrent()) return;
      controllers.delete(record.id);
      const message = error instanceof TypeError
        ? '网络连接中断，服务器接收状态未确认。'
        : error instanceof Error ? error.message : '翻译任务创建未确认，请稍后重试。';
      save({ ...record, status: 'unconfirmed', error: message });
      return;
    }
    if (!isCurrent()) return;
    controllers.delete(record.id);
    remove(record.id);
    options.onCreated(job);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate() {
      active = true;
      storage.retryPersistence();
      if (snapshot.storageWarning !== storage.warning()) publish();
    },
    dispose() {
      active = false;
      const pendingIds = new Set(controllers.keys());
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      for (const record of snapshot.submissions) if (pendingIds.has(record.id)) save(interrupted(record));
    },
    reload() {
      if (!canAct()) return;
      const loaded = storage.load();
      const records = new Map(loaded.records.map((record) => [record.id, interrupted(record)]));
      // Keep this tab's requests in flight and any known snapshots if reads fail.
      for (const record of snapshot.submissions) {
        if (loaded.failed || controllers.has(record.id)) records.set(record.id, record);
      }
      publish([...records.values()]);
    },
    matchesStorageKey: storage.matchesKey,
    hasPending: () => controllers.size > 0,
    enqueue(input: TranslationSubmissionInput) {
      if (!canAct() || snapshot.submissions.some((item) => controllers.has(item.id) && sameRequest(item, input))) return false;
      const record: TranslationSubmission = { ...input, id: createRequestId(), createdAt: Date.now(), status: 'pending', error: '' };
      void attempt(record);
      return true;
    },
    retry(id: string) {
      const record = snapshot.submissions.find((item) => item.id === id);
      return record ? attempt(record) : Promise.resolve();
    },
    remove(id: string) {
      if (canAct() && !controllers.has(id)) remove(id);
    },
  };
}

function interrupted(record: TranslationSubmission): TranslationSubmission {
  return record.status === 'pending' ? { ...record, status: 'unconfirmed', error: INTERRUPTED_TRANSLATION_SUBMISSION } : record;
}

function newestFirst(a: TranslationSubmission, b: TranslationSubmission) {
  return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
}

function sameRequest(a: TranslationSubmissionInput, b: TranslationSubmissionInput) {
  return a.sourceUrl.trim() === b.sourceUrl.trim() && a.model === b.model && a.channelId === b.channelId
    && a.customInstructions.trim() === b.customInstructions.trim() && a.requestConcurrency === b.requestConcurrency;
}
