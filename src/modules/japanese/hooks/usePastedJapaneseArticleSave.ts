import { getAccountScope, subscribeBeforeAccountChange } from '../../../shared/api';
import { writeJapaneseArticleDraft } from '../services/japaneseArticleDraft';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isAbortError } from '../../../shared/utils/abortError';
import {
  createPastedJapaneseArticleSubmission, importPastedJapaneseArticle,
  matchesPastedJapaneseArticleSubmission,
  type PastedJapaneseArticleInput, type PastedJapaneseArticleSubmission,
} from '../services/pastedJapaneseArticle';

export function usePastedJapaneseArticleSave(onImported: () => void, input: PastedJapaneseArticleInput, initialSubmission?: PastedJapaneseArticleSubmission) {
  const submissionRef = useRef<PastedJapaneseArticleSubmission | null>(initialSubmission ?? null);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [bookId, setBookId] = useState<string>();
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const [scope] = useState(getAccountScope);
  const [draftStorageFailed, setDraftStorageFailed] = useState(false);
  const latestInputRef = useRef(input);
  useLayoutEffect(() => { latestInputRef.current = input; }, [input]);
  const persistDraft = () => {
    if (getAccountScope() !== scope) return;
    const current = latestInputRef.current;
    const submission = submissionRef.current;
    const success = writeJapaneseArticleDraft(scope, { input: current,
      submission: submission && matchesPastedJapaneseArticleSubmission(submission, current) ? submission : undefined });
    if (mountedRef.current) setDraftStorageFailed(!success);
  };
  const persistRef = useRef(persistDraft);
  useLayoutEffect(() => { persistRef.current = persistDraft; });
  useEffect(() => {
    const timer = window.setTimeout(() => persistRef.current(), 400);
    return () => window.clearTimeout(timer);
  }, [input.author, input.content, input.sourceUrl, input.title]);
  useEffect(() => {
    const flush = () => persistRef.current();
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    const unsubscribe = subscribeBeforeAccountChange(flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => { flush(); unsubscribe(); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, []);

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsSaving(false);
  };

  const startPreview = (input: PastedJapaneseArticleInput) => {
    cancel();
    const previous = submissionRef.current;
    if (previous && !matchesPastedJapaneseArticleSubmission(previous, input)) submissionRef.current = null;
    const submission = submissionRef.current;
    const savedBookId = submission?.completed ? submission.receipt?.bookId : undefined;
    setBookId(savedBookId);
    setErrorMessage('');
    setStatusMessage(savedBookId ? '已保存，选中文字即可查词或朗读'
      : submission?.receipt ? '文章已上传，可继续完成保存' : '当前仅临时阅读，不会自动加入书架');
  };

  const save = async (input: PastedJapaneseArticleInput) => {
    if (controllerRef.current || bookId) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () => mountedRef.current && controllerRef.current === controller && !controller.signal.aborted;
    setErrorMessage('');
    setStatusMessage('正在保存到书架并生成阅读内容');
    setIsSaving(true);
    try {
      if (!submissionRef.current || !matchesPastedJapaneseArticleSubmission(submissionRef.current, input)) {
        submissionRef.current = createPastedJapaneseArticleSubmission(input);
      }
      persistRef.current();
      const imported = await importPastedJapaneseArticle(input, { submission: submissionRef.current, signal: controller.signal,
        onSubmissionChange: () => { if (isCurrent()) persistRef.current(); } });
      if (!isCurrent()) return;
      setBookId(imported.bookId);
      setStatusMessage('已保存，选中文字即可查词或朗读');
      onImported();
    } catch (error: unknown) {
      if (!isCurrent() || isAbortError(error)) return;
      const message = error instanceof Error ? error.message.trim() : '';
      const detail = error instanceof TypeError || /^failed to fetch$/i.test(message) || /networkerror/i.test(message)
        ? '网络连接失败，请稍后重试' : message || '文章保存失败';
      setStatusMessage('');
      setErrorMessage(submissionRef.current?.receipt
        ? `文章已上传，继续保存会完成原书：${detail}` : `${detail}，当前正文仍可继续阅读`);
    } finally {
      if (isCurrent()) {
        setIsSaving(false);
        controllerRef.current = null;
      }
    }
  };

  return { draftStorageFailed, bookId, errorMessage, statusMessage, isSaving, setErrorMessage, startPreview, save, cancel };
}
