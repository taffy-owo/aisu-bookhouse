import { Check, ExternalLink, Trash2, X } from 'lucide-react';
import { useLayoutEffect } from 'react';
import { Button } from '../../../shared/components/Button';
import { ViewportDialogPortal } from '../../../shared/components/ViewportDialogPortal';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import type { SourceUpdateTranslationReview } from '../../uploads/services/wholeBookTranslationService';

interface TranslationDraftReviewDialogProps {
  errorMessage?: string;
  processingAction: 'accept' | 'reject' | null;
  onAccept: () => void;
  onCancel: () => void;
  onReject: () => void;
  review: SourceUpdateTranslationReview | null;
}

export function TranslationDraftReviewDialog({ errorMessage, processingAction, onAccept, onCancel, onReject, review }: TranslationDraftReviewDialogProps) {
  const isProcessing = processingAction !== null;
  const dialogRef = useDialogFocus<HTMLElement>(review !== null, onCancel, !isProcessing);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!review || !dialog) return;
    const header = dialog.querySelector('header');
    const footer = dialog.querySelector('footer');
    const content = dialog.querySelector<HTMLElement>('.translation-review-content');
    let contentScrollTop = content?.scrollTop ?? 0;
    const rememberContentScroll = () => {
      if (content && dialog.dataset.reviewFlow === 'false' && (window.visualViewport?.height ?? window.innerHeight) > 480) contentScrollTop = content.scrollTop;
    };
    content?.addEventListener('scroll', rememberContentScroll, { passive: true });
    const error = dialog.querySelector('[role="alert"]');
    let frame = 0;
    const update = () => {
      frame = 0;
      const reserved = [header, footer, error].reduce((height, element) => height + (element?.getBoundingClientRect().height ?? 0), 0);
      // Keep the footer visible for long previews. If large text or a short
      // viewport leaves too little preview room, let the entire dialog scroll.
      const flow = dialog.parentElement?.dataset.viewportCompact === 'true'
        || dialog.clientHeight - reserved < Math.min(200, dialog.clientHeight * 0.35);
      const previousFlow = dialog.dataset.reviewFlow;
      const previousDialogScroll = dialog.scrollTop;
      const contentOffset = content ? content.getBoundingClientRect().top - dialog.getBoundingClientRect().top + previousDialogScroll : 0;
      dialog.dataset.reviewFlow = String(flow);
      if (content && previousFlow !== undefined && previousFlow !== String(flow)) {
        // Transfer the reading offset when the scroll owner changes. Compact
        // viewport CSS can already have reset the inner element's scrollTop.
        if (flow && contentScrollTop > 0) {
          const offset = content.getBoundingClientRect().top - dialog.getBoundingClientRect().top + dialog.scrollTop;
          dialog.scrollTop = offset + contentScrollTop;
        } else if (!flow) {
          contentScrollTop = Math.max(0, previousDialogScroll - contentOffset);
          dialog.scrollTop = 0;
          content.scrollTop = contentScrollTop;
        }
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    for (const element of [dialog, header, footer, error]) if (element) observer.observe(element);
    update();
    return () => { observer.disconnect(); content?.removeEventListener('scroll', rememberContentScroll); cancelAnimationFrame(frame); };
  }, [dialogRef, errorMessage, processingAction, review]);
  if (!review) return null;
  const isReviewable = review.status === 'review';
  const description = review.status === 'ready' ? '这批译稿已加入原书，无需再次接受。'
    : review.status === 'rejected' ? '这批译稿已放弃。'
      : !isReviewable ? '译稿尚未进入审核状态，请返回任务查看最新进度。'
        : `共 ${review.chapters.length} 话，接受后才会发布到原书`;

  return (
    <ViewportDialogPortal className="z-[110] grid items-start justify-items-center bg-stone-950/65 backdrop-blur-sm sm:items-center" onClick={isProcessing ? undefined : onCancel}>
      <section aria-busy={isProcessing} aria-describedby="translation-draft-description" aria-labelledby="translation-draft-title" aria-modal="true" className="book-management-dialog book-action-dialog translation-review-dialog flex max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-[880px] flex-col overflow-hidden rounded-lg bg-shell shadow-[0_28px_100px_rgba(20,16,20,0.38)] dark:bg-[#1d1722]" onClick={(event) => event.stopPropagation()} ref={dialogRef} role="dialog" tabIndex={-1}>
        <header className="translation-review-heading flex shrink-0 items-start justify-between gap-4 border-b border-stone-200 px-5 py-4 dark:border-white/10 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-medium text-accent dark:text-peach">连载更新译稿</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-stone-950 [overflow-wrap:anywhere] dark:text-night-ink" id="translation-draft-title">{review.title}</h2>
            <p className="mt-1 text-xs text-stone-400" id="translation-draft-description">{description}</p>
          </div>
          <button aria-label="关闭译稿查看" className="book-dialog-close grid h-11 w-11 shrink-0 place-items-center rounded-md text-stone-400 transition hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-white/10 dark:hover:text-night-ink" disabled={isProcessing} onClick={onCancel} type="button"><X className="h-4 w-4" /></button>
        </header>

        <div className="translation-review-content notranslate min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 reader-scrollbar sm:px-6" translate="no">
          {!review.chapters.length && <p role="status" className="py-6 text-sm text-stone-500 dark:text-night-soft">暂无可预览的译稿。</p>}
          <div className="divide-y divide-stone-200 dark:divide-white/10">
            {review.chapters.map((chapter, position) => (
              <details className="group py-4" key={chapter.index} open={position === 0}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-left marker:hidden">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-stone-900 [overflow-wrap:anywhere] dark:text-night-ink">{chapter.title}</span>
                    {chapter.source_title && chapter.source_title !== chapter.title && <span className="mt-1 block text-xs text-stone-400 [overflow-wrap:anywhere]">原题：{chapter.source_title}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-accent group-open:text-stone-400 dark:text-peach"><span className="group-open:hidden">展开</span><span className="hidden group-open:inline">收起</span></span>
                </summary>
                <div className="mt-4 border-l-2 border-pink-200 pl-4 dark:border-pink-400/25">
                  <div className="translation-review-prose space-y-4 whitespace-pre-wrap font-display text-[15px] leading-8 text-stone-700 [overflow-wrap:anywhere] dark:text-night-copy">
                    {chapter.content.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                  </div>
                  {chapter.source_url && <a className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-xs text-stone-400 transition hover:text-accent" href={chapter.source_url} rel="noreferrer" target="_blank">查看这一话原文 <ExternalLink className="h-3.5 w-3.5" /></a>}
                </div>
              </details>
            ))}
          </div>
        </div>

        {errorMessage && <p aria-label="译稿操作失败详情" role="alert" tabIndex={0} className="translation-review-error max-h-24 shrink-0 overflow-y-auto whitespace-pre-wrap overscroll-contain border-t border-red-100 bg-red-50 px-5 py-3 text-sm text-red-600 [overflow-wrap:anywhere] dark:border-red-950/50 dark:bg-red-950/20 dark:text-red-300 sm:px-6">{errorMessage}</p>}
        <footer className="translation-review-footer book-action-footer grid shrink-0 grid-cols-2 gap-2 border-t border-stone-200 px-5 py-4 dark:border-white/10 sm:flex sm:items-center sm:gap-3 sm:px-6">
          <Button aria-busy={processingAction === 'reject'} className="col-span-2 sm:mr-auto" disabled={isProcessing || !isReviewable} icon={<Trash2 className="h-4 w-4" />} onClick={onReject} variant="ghost">{processingAction === 'reject' ? '正在放弃译稿…' : '放弃这批译稿'}</Button>
          <Button aria-label="关闭译稿预览" disabled={isProcessing} onClick={onCancel} variant="secondary">{isReviewable ? '稍后决定' : '关闭预览'}</Button>
          <Button aria-busy={processingAction === 'accept'} className="min-w-0 px-3 sm:px-4" disabled={isProcessing || !isReviewable || !review.chapters.length} icon={<Check className="h-4 w-4" />} onClick={onAccept}>{processingAction === 'accept' ? '正在确认译稿…' : `接受并加入 ${review.chapters.length} 话`}</Button>
        </footer>
      </section>
    </ViewportDialogPortal>
  );
}
