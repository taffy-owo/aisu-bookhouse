import { ImageOff, LoaderCircle, Minus, Plus, RefreshCw, RotateCcw, Sparkles, X, ZoomIn } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAuthenticatedImageResource } from '../../../shared/hooks/useAuthenticatedImageUrl';
import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';
import { cn } from '../../../shared/utils/cn';
import type { BookLanguage } from '../../books/types/book';
import type { ReaderChapterBlock, ReaderInlineSpan, ReaderTheme } from '../types/reader';
import { JapaneseSelectionAssistant } from '../../japanese/components/JapaneseSelectionAssistant';
import type { JapaneseFuriganaMode, JapaneseTranslationMode } from '../../japanese/services/japaneseLayoutPreferences';
import { normalizeJapaneseReadableBlocks } from '../../japanese/services/japaneseTypography';
import { annotateJapaneseBlocks, hasMissingJapaneseAnnotations } from '../../japanese/services/japaneseAnnotationService';
import { translateJapaneseTexts } from '../../japanese/services/japaneseAiTranslationService';
import { convertReaderBlocksToSimplified } from '../services/chineseScriptConversion';
import { mapRenderedBlocksToAudiobookParagraphs } from '../utils/audiobookParagraphMapping';
import { countReaderBlockMatches, getDuplicateChapterHeadingIndex, resolveReaderChapterBlocks } from '../utils/readerContent';
import { findTextMatches } from '../utils/readerMetrics';
import { getAutoParagraphAlignment } from '../utils/readerParagraphAlignment';
import type { ReaderPreferences } from '../services/readerPreferences';
import { readerTextAlignClass } from '../constants/readerDisplayClasses';
import { AUDIOBOOK_FOLLOW_EVENT, getAudiobookFollowScrollTop } from '../utils/audiobookTextFollow';
import { observeReaderAudiobookPlayer } from '../utils/readerAudiobookPlayer';
import { READER_CONTROLS_LAYOUT_EVENT } from '../utils/readerControlsLayout';

interface NovelContentProps {
  activeAudiobookParagraphIndex?: number;
  activeSearchMatchIndex?: number;
  blocks?: ReaderChapterBlock[];
  bookId?: string;
  chapterTitle: string;
  chapterTitleLanguage?: string;
  chapterNavigation?: ReactNode;
  chapterStartNavigation?: ReactNode;
  chineseScript?: 'original' | 'simplified';
  content: string;
  bodyFontClassName?: string;
  contentWidthClassName?: string;
  fontClassName?: string;
  fontWeightClassName?: string;
  followAudiobookText?: boolean;
  embedded?: boolean;
  isLoading?: boolean;
  language?: BookLanguage;
  japaneseFuriganaMode?: JapaneseFuriganaMode;
  japaneseLayout?: 'original' | 'readable';
  japaneseTranslationMode?: JapaneseTranslationMode;
  lineHeightClassName?: string;
  pagePaddingClassName?: string;
  paragraphSpacingClassName?: string;
  readerTheme?: ReaderTheme;
  selectionAssistantDisabled?: boolean;
  searchQuery?: string;
  onSearchMatchCountChange?: (count: number) => void;
  textAlign?: ReaderPreferences['textAlign'];
  textIndentClassName?: string;
  title: string;
  titleLanguage?: string;
}

type ZoomedIllustration = {
  alt: string;
  imageHeight?: number;
  imageUrl: string;
  imageWidth?: number;
};

export function NovelContent({
  activeAudiobookParagraphIndex,
  activeSearchMatchIndex = -1,
  blocks,
  bookId,
  bodyFontClassName = 'font-display',
  chapterTitle,
  chapterTitleLanguage,
  chapterNavigation,
  chapterStartNavigation,
  chineseScript = 'original',
  content,
  contentWidthClassName = 'max-w-[760px]',
  embedded = false,
  fontClassName = 'text-[18px] md:text-[20px]',
  fontWeightClassName = 'font-normal',
  followAudiobookText = false,
  isLoading = false,
  language = 'und',
  japaneseFuriganaMode = 'on-demand',
  japaneseLayout = 'readable',
  japaneseTranslationMode = 'off',
  lineHeightClassName = 'leading-[1.85]',
  pagePaddingClassName = 'px-5 sm:px-6 md:px-12',
  paragraphSpacingClassName = 'space-y-4',
  readerTheme = 'paper',
  selectionAssistantDisabled = false,
  searchQuery = '',
  onSearchMatchCountChange,
  textAlign = 'auto',
  textIndentClassName = 'indent-[2em]',
  title,
  titleLanguage,
}: NovelContentProps) {
  const isJapanese = language === 'ja';
  const contentLanguage = getContentLanguage(language, chineseScript);
  const articleRef = useRef<HTMLElement | null>(null);
  const rawSourceBlocks = useMemo(() => {
    const resolvedBlocks = resolveReaderChapterBlocks(blocks, content);
    return language === 'zh' && chineseScript === 'simplified'
      ? convertReaderBlocksToSimplified(resolvedBlocks)
      : resolvedBlocks;
  }, [blocks, chineseScript, content, language]);
  const sourceBlocks = useMemo(() => {
    return isJapanese && japaneseLayout === 'readable' ? normalizeJapaneseReadableBlocks(rawSourceBlocks) : rawSourceBlocks;
  }, [isJapanese, japaneseLayout, rawSourceBlocks]);
  const audiobookParagraphIndexes = useMemo(
    () => mapRenderedBlocksToAudiobookParagraphs(rawSourceBlocks, sourceBlocks),
    [rawSourceBlocks, sourceBlocks],
  );
  const [annotation, setAnnotation] = useState<{ source: ReaderChapterBlock[]; blocks?: ReaderChapterBlock[]; error?: string } | null>(null);
  const [annotationRevision, setAnnotationRevision] = useState(0);
  const [translations, setTranslations] = useState<Map<string, string>>(() => new Map());
  const [translationError, setTranslationError] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationRevision, setTranslationRevision] = useState(0);
  const [zoomedIllustration, setZoomedIllustration] = useState<ZoomedIllustration | null>(null);
  const needsAnnotation = useMemo(() => isJapanese && hasMissingJapaneseAnnotations(sourceBlocks), [isJapanese, sourceBlocks]);
  const currentAnnotation = isJapanese && annotation?.source === sourceBlocks ? annotation : null;
  const hasGeneratedAnnotations = Boolean(currentAnnotation?.blocks);
  const shouldAnnotate = needsAnnotation && japaneseFuriganaMode !== 'off' && !isLoading;
  const annotationError = shouldAnnotate ? currentAnnotation?.error : undefined;
  const isAnnotating = shouldAnnotate && !hasGeneratedAnnotations && !annotationError;
  const contentBlocks = currentAnnotation?.blocks ?? sourceBlocks;
  const sourceTextOffsets = useMemo(() => {
    let offset = 0;
    const offsets: number[] = [];
    for (const block of contentBlocks) {
      offsets.push(offset);
      if (block.type !== 'image') offset += block.text.length;
    }
    return offsets;
  }, [contentBlocks]);
  const paragraphAlignments = useMemo(() => textAlign === 'auto'
    ? contentBlocks.map((block) => block.type === 'paragraph' ? getAutoParagraphAlignment(block.text) : undefined)
    : [], [contentBlocks, textAlign]);
  const protectBilingualText = isJapanese && japaneseTranslationMode === 'bilingual';
  const duplicateChapterHeadingIndex = useMemo(() => getDuplicateChapterHeadingIndex(contentBlocks, chapterTitle), [contentBlocks, chapterTitle]);
  const renderedMatchCount = useMemo(() => isLoading ? 0 : countReaderBlockMatches(contentBlocks, searchQuery, chapterTitle), [contentBlocks, searchQuery, chapterTitle, isLoading]);
  useEffect(() => { onSearchMatchCountChange?.(renderedMatchCount); }, [onSearchMatchCountChange, renderedMatchCount]);
  const translatableTexts = useMemo(() => [...new Set(sourceBlocks
    .filter((block) => block.type === 'paragraph')
    .map((block) => block.text.trim())
    .filter(Boolean))], [sourceBlocks]);

  useEffect(() => {
    if (!followAudiobookText || activeAudiobookParagraphIndex === undefined) return;
    const article = articleRef.current;
    const target = article?.querySelector<HTMLElement>(`[data-audiobook-paragraphs~="${activeAudiobookParagraphIndex}"]`);
    const shell = article?.closest<HTMLElement>('.reader-viewport');
    if (!target || !shell) return;
    const root = shell.closest('.reader-with-reading-status');
    const documentScroll = shell.classList.contains('reader-document-scroll');
    const scroller = documentScroll ? document.scrollingElement : shell;
    if (!scroller) return;
    const header = root?.querySelector<HTMLElement>('.reader-chrome-top');
    const footer = root?.querySelector<HTMLElement>('.reader-bottom-bar');
    let player: HTMLElement | null = null;
    const viewport = window.visualViewport;
    let frame = 0;
    let didScroll = false;
    const follow = () => {
      frame = 0;
      if (document.body.style.position === 'fixed' || !target.isConnected) return;
      const screenTop = viewport?.offsetTop ?? 0;
      const screenBottom = screenTop + (viewport?.height ?? window.innerHeight);
      const shellBounds = shell.getBoundingClientRect();
      const top = Math.max(screenTop, documentScroll ? screenTop : shellBounds.top,
        header && !header.inert ? header.getBoundingClientRect().bottom : screenTop) + 12;
      const bottom = Math.min(screenBottom, documentScroll ? screenBottom : shellBounds.bottom,
        footer && !footer.inert ? footer.getBoundingClientRect().top : screenBottom,
        player?.getBoundingClientRect().top ?? screenBottom) - 12;
      const nextTop = getAudiobookFollowScrollTop(target.getBoundingClientRect(), { top, bottom }, scroller.scrollTop);
      if (nextTop === null || Math.abs(nextTop - scroller.scrollTop) < 1) return;
      // Playback owns the reading position now. Release startup anchoring so
      // this scroll is saved, including after an automatic chapter advance.
      shell.dispatchEvent(new Event(AUDIOBOOK_FOLLOW_EVENT, { bubbles: true }));
      didScroll = true;
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
      // Scroll only the owning viewport; scrollIntoView also moves ancestors
      // and treats a native mobile reader's full chapter as its visible area.
      if (documentScroll) window.scrollTo({ top: nextTop, behavior });
      else shell.scrollTo({ top: nextTop, behavior });
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(follow); };
    const transition = (event: Event) => {
      if (event.target === header || event.target === footer || event.target === player) schedule();
    };
    const mutations = new MutationObserver(schedule);
    for (const element of [header, footer]) if (element) {
      mutations.observe(element, { attributes: true, attributeFilter: ['inert', 'aria-hidden', 'class'] });
    }
    root?.addEventListener('transitionend', transition);
    root?.addEventListener(READER_CONTROLS_LAYOUT_EVENT, schedule);
    const observer = new ResizeObserver(schedule);
    for (const element of [article, shell, header, footer]) if (element) observer.observe(element);
    const stopTrackingPlayer = root ? observeReaderAudiobookPlayer(root, observer, (next) => {
      player = next;
      schedule();
    }) : undefined;
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      stopTrackingPlayer?.();
      observer.disconnect();
      mutations.disconnect();
      root?.removeEventListener('transitionend', transition);
      root?.removeEventListener(READER_CONTROLS_LAYOUT_EVENT, schedule);
      if (didScroll && target.isConnected && shell.isConnected) {
        // Stop an already-started smooth follow when disabling it or opening a sheet.
        if (documentScroll) window.scrollTo({ top: scroller.scrollTop, behavior: 'instant' });
        else shell.scrollTo({ top: scroller.scrollTop, behavior: 'instant' });
      }
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, [activeAudiobookParagraphIndex, audiobookParagraphIndexes, followAudiobookText, isLoading]);

  useEffect(() => {
    if (!shouldAnnotate || hasGeneratedAnnotations) return;

    const controller = new AbortController();
    setAnnotation({ source: sourceBlocks });
    void annotateJapaneseBlocks(sourceBlocks, controller.signal)
      .then((nextBlocks) => {
        if (!controller.signal.aborted) setAnnotation({ source: sourceBlocks, blocks: nextBlocks });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setAnnotation({ source: sourceBlocks, error: error instanceof Error ? error.message : '注音生成失败，请重试' });
        }
      });

    return () => controller.abort();
  }, [annotationRevision, hasGeneratedAnnotations, shouldAnnotate, sourceBlocks]);

  useEffect(() => {
    setTranslationError('');
    if (!isJapanese || japaneseTranslationMode !== 'bilingual' || !translatableTexts.length) {
      setIsTranslating(false);
      return;
    }

    const controller = new AbortController();
    setIsTranslating(true);
    void translateJapaneseTexts(translatableTexts, {
      context: { chapterTitle, workTitle: title },
      onProgress: (nextTranslations) => {
        if (!controller.signal.aborted) setTranslations(nextTranslations);
      },
      signal: controller.signal,
    })
      .then((nextTranslations) => {
        if (!controller.signal.aborted) setTranslations(nextTranslations);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setTranslationError(error instanceof Error ? error.message : 'AI 翻译失败，请重试');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsTranslating(false);
      });

    return () => controller.abort();
  }, [chapterTitle, isJapanese, japaneseTranslationMode, title, translatableTexts, translationRevision]);

  // Progress saves and toolbar changes do not change the chapter text.
  const renderedBlocks = useMemo(() => {
    if (isLoading) return null;
    const searchMatchCursor = { value: 0 };
    return contentBlocks.map((block, index) => {
      if (index === duplicateChapterHeadingIndex) return null;
      const paragraphIndexes = audiobookParagraphIndexes[index] ?? [];
      const isAudiobookActive = activeAudiobookParagraphIndex !== undefined
        && paragraphIndexes.includes(activeAudiobookParagraphIndex);
      if (block.type === 'image') {
        return (
          <NovelImageBlock
            alt={block.alt}
            imageHeight={block.imageHeight}
            imageUrl={block.imageUrl}
            imageWidth={block.imageWidth}
            key={`${index}-${block.imageUrl ?? 'image'}`}
            onZoom={setZoomedIllustration}
          />
        );
      }

      const rendered = searchQuery.trim()
        ? renderHighlightedBlock(block, searchQuery, searchMatchCursor, activeSearchMatchIndex)
        : renderRichBlockText(block);

      if (block.type === 'heading') {
        return (
          <div
            className={cn(isAudiobookActive && 'reader-audiobook-active')}
            data-audiobook-paragraphs={paragraphIndexes.join(' ') || undefined}
            data-reader-source-start={sourceTextOffsets[index]}
            data-reader-source-length={block.text.length}
            key={`${index}-h-${block.text.slice(0, 18)}`}
          >
            <ReaderHeading level={block.level}>{rendered}</ReaderHeading>
          </div>
        );
      }

      const translation = protectBilingualText ? translations.get(block.text.trim()) : undefined;
      return (
        <div
          className={cn('reader-bilingual-block', isAudiobookActive && 'reader-audiobook-active')}
          data-audiobook-paragraphs={paragraphIndexes.join(' ') || undefined}
          data-reader-source-start={sourceTextOffsets[index]}
          data-reader-source-length={block.text.length}
          key={`${index}-${block.text.slice(0, 18)}`}
        >
          <p className={textIndentClassName} dir="auto" style={textAlign === 'auto' ? { textAlign: paragraphAlignments[index] } : undefined}>{rendered}</p>
          {translation && <p className="reader-ai-translation" lang="zh-CN"><Sparkles aria-hidden="true" className="h-3 w-3 shrink-0" />{translation}</p>}
        </div>
      );
    });
  }, [activeAudiobookParagraphIndex, activeSearchMatchIndex, audiobookParagraphIndexes, contentBlocks, duplicateChapterHeadingIndex, isLoading, paragraphAlignments, protectBilingualText, searchQuery, sourceTextOffsets, textAlign, textIndentClassName, translations]);

  return (
    <div className={cn('reader-page-surface', embedded && 'reader-page-surface-embedded')}>
      {chapterStartNavigation}
      <article ref={articleRef} tabIndex={-1} className={cn(
        `reader-content reader-content-enter relative z-[1] focus:outline-none mx-auto ${pagePaddingClassName} ${contentWidthClassName}`,
        embedded ? 'py-10 sm:py-14' : 'reader-content-safe sm:py-24',
        Boolean(chapterStartNavigation) && 'reader-content-with-chapter-start',
        !isLoading && Boolean(chapterNavigation) && 'reader-content-with-chapter-footer',
        isJapanese && japaneseLayout === 'readable' && 'reader-japanese-readable',
        isJapanese && japaneseLayout === 'original' && 'reader-japanese-original',
        isJapanese && `reader-furigana-${japaneseFuriganaMode}`,
      )} lang={contentLanguage}>
      <div className={cn("text-center", !embedded && "reader-chapter-heading")}>
        <div className="reader-muted mb-4 text-xs tracking-[0.22em]" lang={titleLanguage}>{title}</div>
         <h1 className={cn('font-display font-semibold', embedded ? 'text-2xl sm:text-3xl' : 'text-3xl md:text-4xl')} lang={chapterTitleLanguage}>{chapterTitle}</h1>
         <div className={cn('reader-hairline mx-auto w-full max-w-3xl border-t border-dotted', embedded ? 'mt-6' : 'mt-8')} />
         {isJapanese && isAnnotating && (
           <div aria-live="polite" className="reader-muted mt-4 inline-flex items-center gap-2 text-xs" lang="zh-CN">
             <LoaderCircle className="h-3.5 w-3.5 animate-spin" />正在生成注音
           </div>
         )}
         {isJapanese && annotationError && (
           <button
             className="reader-muted mt-4 inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-xs transition hover:bg-current/[0.06]"
             lang="zh-CN"
             onClick={(event) => {
               event.stopPropagation();
               setAnnotationRevision((revision) => revision + 1);
             }}
             type="button"
           >
             <RefreshCw className="h-3.5 w-3.5" />注音生成失败，点击重试
           </button>
         )}
         {isJapanese && japaneseTranslationMode === 'bilingual' && isTranslating && (
           <div aria-live="polite" className="reader-muted mt-4 inline-flex items-center gap-2 text-xs" lang="zh-CN">
             <Sparkles className="h-3.5 w-3.5" />AI 正在翻译 · {translations.size}/{translatableTexts.length}
           </div>
         )}
         {isJapanese && japaneseTranslationMode === 'bilingual' && translationError && (
           <button
             className="reader-muted mt-4 inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-xs transition hover:bg-current/[0.06]"
             lang="zh-CN"
             onClick={(event) => {
               event.stopPropagation();
               setTranslationRevision((revision) => revision + 1);
             }}
             type="button"
           >
             <RefreshCw className="h-3.5 w-3.5" />AI 翻译失败，点击重试
           </button>
         )}
       </div>

      <div
        className={cn(`reader-body-text mt-10 ${paragraphSpacingClassName} ${bodyFontClassName} ${fontClassName} ${fontWeightClassName} ${lineHeightClassName} ${readerTextAlignClass[textAlign]}`, protectBilingualText && 'notranslate')}
        key={protectBilingualText ? 'bilingual' : 'original'}
        translate={protectBilingualText ? 'no' : undefined}
      >
        {isLoading ? (
          <p className="text-center text-base opacity-60" lang="zh-CN">正在打开正文...</p>
        ) : (
          renderedBlocks
        )}
      </div>
      </article>
      {!isLoading && chapterNavigation}

      {isJapanese && <JapaneseSelectionAssistant articleRef={articleRef} bookId={bookId} chapterTitle={chapterTitle} disabled={selectionAssistantDisabled || isLoading || Boolean(zoomedIllustration)} theme={readerTheme} workTitle={title} />}

      {zoomedIllustration && createPortal(<IllustrationViewer illustration={zoomedIllustration} onClose={() => setZoomedIllustration(null)} />, document.body)}
    </div>
  );
}

function getContentLanguage(language: BookLanguage, chineseScript: 'original' | 'simplified'): string {
  if (language === 'zh') return chineseScript === 'simplified' ? 'zh-Hans' : 'zh';
  if (language === 'ja' || language === 'en') return language;
  // An empty lang explicitly stops inheritance from the Chinese application UI.
  return '';
}

function renderHighlightedBlock(block: { spans?: ReaderInlineSpan[]; text: string }, query: string, cursor: { value: number }, activeMatchIndex: number): ReactNode {
  const matches = findTextMatches(block.text, query);
  if (!matches.length) return renderRichBlockText(block);
  const firstMatchIndex = cursor.value;
  cursor.value += matches.length;
  let matchCursor = 0;
  let offset = 0;
  const renderSegment = (text: string) => {
    const start = offset;
    const end = start + text.length;
    offset = end;
    const nodes: ReactNode[] = [];
    let consumed = start;
    // A match crossing a rich-span boundary is painted in both spans but
    // retains one search index. Ruby and emphasis stay around their base text.
    while (matchCursor < matches.length && matches[matchCursor].start < end) {
      const match = matches[matchCursor];
      const from = Math.max(start, match.start);
      const to = Math.min(end, match.end);
      if (from > consumed) nodes.push(text.slice(consumed - start, from - start));
      const active = firstMatchIndex + matchCursor === activeMatchIndex;
      nodes.push(<mark
        className={active ? 'reader-search-mark reader-search-active' : 'reader-search-mark'}
        data-reader-search-active={active ? 'true' : undefined}
        key={matchCursor}
      >{text.slice(from - start, to - start)}</mark>);
      consumed = to;
      if (match.end > end) break;
      matchCursor += 1;
    }
    if (consumed < end) nodes.push(text.slice(consumed - start));
    return nodes;
  };
  if (block.spans?.length && block.spans.map((span) => span.text).join('') === block.text) {
    return block.spans.map((span, index) => <RichSpan key={index} span={span}>{renderSegment(span.text)}</RichSpan>);
  }
  return renderSegment(block.text);
}

// Rich inline rendering. Everything is assembled from React elements and a
// whitelisted mark set — never dangerouslySetInnerHTML — so book content can
// never inject markup, preserving the reader's XSS-safe baseline.
function renderRichBlockText(block: { spans?: ReaderInlineSpan[]; text: string }): ReactNode {
  if (!block.spans?.length) {
    return block.text;
  }

  return block.spans.map((span, index) => <RichSpan key={index} span={span} />);
}

function RichSpan({ span, children }: { span: ReaderInlineSpan; children?: ReactNode }): ReactNode {
  let node: ReactNode = children ?? span.text;

  if (span.ruby) {
    node = (
      <ruby tabIndex={0}>
        {node}
        <rt>{span.ruby}</rt>
      </ruby>
    );
  }

  const marks = span.marks ?? [];
  if (marks.includes('emphasis_dot')) {
    node = <span className="reader-emphasis-dot">{node}</span>;
  }
  if (marks.includes('emphasis')) {
    node = <em>{node}</em>;
  }
  if (marks.includes('strong')) {
    node = <strong>{node}</strong>;
  }

  return node;
}

function ReaderHeading({ children, level }: { children: ReactNode; level: number }): ReactNode {
  const safeLevel = Math.min(6, Math.max(1, Math.floor(level) || 2));
  const className = `reader-heading reader-heading-l${safeLevel}`;
  // Keep the chapter's own <h1> unique: body headings render as h2–h4.
  if (safeLevel <= 2) {
    return <h2 className={className}>{children}</h2>;
  }
  if (safeLevel === 3) {
    return <h3 className={className}>{children}</h3>;
  }
  return <h4 className={className}>{children}</h4>;
}

// Start the authenticated download shortly before the illustration scrolls
// into view. `loading="lazy"` cannot defer anything here: the src is a blob
// URL, so the expensive part (the authenticated fetch in the hook) would
// otherwise run for every illustration the moment the chapter mounts.
const IMAGE_LAZY_ROOT_MARGIN = '200% 0px 200% 0px';

const imagePlaceholderClassName = 'reader-illustration-placeholder mx-auto grid w-full place-items-center';

function NovelImageBlock({ alt, imageHeight, imageUrl, imageWidth, onZoom }: {
  alt?: string;
  imageHeight?: number;
  imageUrl?: string;
  imageWidth?: number;
  onZoom: (illustration: ZoomedIllustration) => void;
}) {
  const figureRef = useRef<HTMLElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [resolvedSize, setResolvedSize] = useState(() => normalizeImageSize(imageWidth, imageHeight));
  // Hooks cannot be called conditionally, but the hook accepts undefined —
  // withhold the URL until the block approaches the viewport.
  const image = useAuthenticatedImageResource(isNearViewport ? imageUrl : undefined);

  useEffect(() => {
    setResolvedSize(normalizeImageSize(imageWidth, imageHeight));
  }, [imageHeight, imageWidth]);

  useEffect(() => {
    const element = figureRef.current;
    if (!element || isNearViewport) {
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return;
    }

    // Root must be the reader's scroll container: rootMargin only expands the
    // root's own box, and intermediate scroll containers clip the target rect,
    // so with the default viewport root the 200% preload margin would never
    // trigger for content scrolled below the shell's fold. Both reading modes
    // (scroll and paged, whose overflow-hidden shell still moves via scrollTo)
    // share that shell. Fall back to the viewport root, where the observer
    // still fires once the image actually becomes visible.
    const readerViewport = element.closest('.reader-viewport');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { root: readerViewport?.classList.contains('reader-document-scroll') ? null : readerViewport, rootMargin: IMAGE_LAZY_ROOT_MARGIN },
    );
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [isNearViewport]);

  const orientation = resolvedSize && resolvedSize.width > resolvedSize.height ? 'landscape' : 'portrait';
  const imageFrameStyle = {
    aspectRatio: resolvedSize ? `${resolvedSize.width} / ${resolvedSize.height}` : '3 / 4',
    // Match the image's intrinsic width and its responsive height limit so
    // lazy placeholders cannot move text when entering or resuming a chapter.
    maxWidth: resolvedSize
      ? `min(${resolvedSize.width}px, calc(var(--reader-illustration-max-height) * ${resolvedSize.width / resolvedSize.height}))`
      : 'calc(var(--reader-illustration-max-height) * .75)',
  } satisfies CSSProperties;

  return (
    <figure className="reader-illustration text-center" data-orientation={orientation} ref={figureRef}>
      {!imageUrl ? (
        <div className={cn(imagePlaceholderClassName, 'bg-current/[0.03] px-6 text-sm opacity-55')} style={imageFrameStyle}>插图暂不可用</div>
      ) : image.status === 'error' ? (
        <button
          className={cn(imagePlaceholderClassName, 'bg-current/[0.04] px-6 transition hover:bg-current/[0.07]')}
          onClick={(event) => {
            event.stopPropagation();
            image.retry();
          }}
          style={imageFrameStyle}
          type="button"
        >
          <span className="inline-flex items-center gap-2 text-sm opacity-60">
            <ImageOff className="h-4 w-4" />
            插图加载失败 · 点击重试
          </span>
        </button>
      ) : image.url ? (
        <button
          aria-label="放大查看插图"
          data-reader-edge-page-turn
          className="group relative mx-auto block w-full max-w-full cursor-zoom-in"
          style={imageFrameStyle}
          onClick={(event) => {
            event.stopPropagation();
            if (image.url) {
              onZoom({ alt: alt ?? '章节插图', imageHeight: resolvedSize?.height, imageUrl: image.url, imageWidth: resolvedSize?.width });
            }
          }}
          type="button"
        >
          <img
            alt={alt ?? '章节插图'}
            className="reader-illustration-image mx-auto h-auto w-full max-w-full animate-fade-in object-contain"
            decoding="async"
            height={resolvedSize?.height}
            onError={image.onError}
            onLoad={(event) => setResolvedSize(normalizeImageSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight))}
            src={image.url}
            width={resolvedSize?.width}
          />
          <span className="pointer-events-none absolute bottom-3 right-3 grid h-8 w-8 place-items-center rounded-full bg-black/45 text-white opacity-0 transition group-hover:opacity-100">
            <ZoomIn className="h-4 w-4" />
          </span>
        </button>
      ) : (
        <div aria-label="插图加载中" className={cn(imagePlaceholderClassName, 'animate-pulse bg-current/[0.05]')} role="img" style={imageFrameStyle} />
      )}
    </figure>
  );
}

function IllustrationViewer({ illustration, onClose }: { illustration: ZoomedIllustration; onClose: () => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState(() => normalizeImageSize(illustration.imageWidth, illustration.imageHeight));
  const [viewportSize, setViewportSize] = useState(() => ({ height: window.innerHeight, width: window.innerWidth }));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === '+' || event.key === '=') { event.preventDefault(); setZoom((value) => Math.min(3, value + 0.5)); }
      if (event.key === '-') { event.preventDefault(); setZoom((value) => Math.max(1, value - 0.5)); }
      if (event.key === '0') { event.preventDefault(); setZoom(1); }
    };
    const handleResize = () => setViewportSize({ height: window.innerHeight, width: window.innerWidth });
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [onClose]);

  const fitScale = naturalSize ? Math.min(1, (viewportSize.width - 32) / naturalSize.width, (viewportSize.height - 32) / naturalSize.height) : 1;
  const displayedWidth = naturalSize ? Math.round(naturalSize.width * fitScale * zoom) : undefined;
  const displayedHeight = naturalSize ? Math.round(naturalSize.height * fitScale * zoom) : undefined;
  const stageStyle = displayedWidth && displayedHeight ? {
    height: Math.max(viewportSize.height, displayedHeight + 32),
    width: Math.max(viewportSize.width, displayedWidth + 32),
  } satisfies CSSProperties : undefined;

  return (
    <div aria-label="插图大图" aria-modal="true" className="reader-illustration-viewer fixed inset-0 z-[120] overflow-auto bg-black/95 overscroll-contain" onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} ref={dialogRef} role="dialog" tabIndex={-1}>
      <div className="flex min-h-full min-w-full items-center justify-center p-4" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} style={stageStyle}>
        <img
          alt={illustration.alt}
          className="block select-none object-contain"
          decoding="async"
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onLoad={(event) => setNaturalSize(normalizeImageSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight))}
          src={illustration.imageUrl}
          style={displayedWidth ? { height: 'auto', maxHeight: 'none', maxWidth: 'none', width: displayedWidth } : { maxHeight: 'calc(100svh - 2rem)', maxWidth: 'calc(100vw - 2rem)' }}
        />
      </div>
      <button aria-label="关闭插图" className="fixed right-3 top-3 grid h-11 w-11 place-items-center rounded-full bg-black/55 text-white/80 backdrop-blur-md transition hover:bg-black/75 hover:text-white sm:right-5 sm:top-5" onClick={(event) => { event.stopPropagation(); onClose(); }} title="关闭" type="button"><X className="h-5 w-5" /></button>
      <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/60 p-1.5 text-white/80 backdrop-blur-md">
        <button aria-label="缩小插图" className="grid h-11 w-11 place-items-center rounded-full transition hover:bg-white/15 hover:text-white disabled:opacity-35" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 0.5))} title="缩小" type="button"><Minus className="h-4 w-4" /></button>
        <button aria-label="恢复适应屏幕" className="grid h-11 min-w-14 place-items-center rounded-full px-2 text-xs tabular-nums transition hover:bg-white/15 hover:text-white" onClick={() => setZoom(1)} title="适应屏幕" type="button">{Math.round(zoom * 100)}%</button>
        <button aria-label="放大插图" className="grid h-11 w-11 place-items-center rounded-full transition hover:bg-white/15 hover:text-white disabled:opacity-35" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + 0.5))} title="放大" type="button"><Plus className="h-4 w-4" /></button>
        <button aria-label="复位插图" className="grid h-11 w-11 place-items-center rounded-full transition hover:bg-white/15 hover:text-white" onClick={() => setZoom(1)} title="复位" type="button"><RotateCcw className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

function normalizeImageSize(width: number | undefined, height: number | undefined): { height: number; width: number } | null {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { height, width };
}

