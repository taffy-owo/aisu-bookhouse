import { BookOpenText, ImageOff, LoaderCircle } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useAuthenticatedImageResource } from '../../../shared/hooks/useAuthenticatedImageUrl';
import { cn } from '../../../shared/utils/cn';
import { kindLabel } from '../services/bookService';
import { getBookCoverUrl } from '../services/bookCoverUrl';
import type { Book } from '../types/book';

interface BookCoverProps {
  book: Book;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}

const sizeClass = {
  lg: 'h-44 w-28 rounded-xl',
  md: 'aspect-[0.68] w-full rounded-xl',
  sm: 'h-24 w-16 rounded-lg',
  xl: 'h-[310px] w-[210px] rounded-2xl',
  xs: 'h-12 w-8 rounded-md',
};

const contentPaddingClass = {
  lg: 'py-4 pl-[18%] pr-3',
  md: 'py-[10%] pl-[18%] pr-[10%]',
  sm: 'py-2.5 pl-[18%] pr-2',
  xl: 'py-7 pl-[18%] pr-6',
  xs: 'py-1 pl-[18%] pr-1',
};

const titleClass = {
  lg: 'text-sm leading-[1.35]',
  md: 'text-[clamp(11px,8.2cqi,18px)] leading-[1.4]',
  sm: 'text-[10px] leading-snug',
  xl: 'text-2xl leading-[1.28]',
  xs: 'text-[7px] leading-none scale-[0.8] origin-left-bottom font-medium',
};

const titleLineClamp = {
  lg: 5,
  md: 4,
  sm: 3,
  xl: 5,
  xs: 1,
};

const metaClass = {
  lg: 'text-[11px]',
  md: 'text-[11px]',
  sm: 'text-[10px]',
  xl: 'text-xs',
  xs: 'text-[6px] scale-[0.7] origin-left',
};

const coverPalettes = [
  {
    accent: '#bf5b4f',
    base: '#f6efe2',
    night: '#dfcfc1',
    edge: '#8b4a41',
    ink: '#3d2e29',
    muted: '#7b655a',
    paper: '#fffaf0',
  },
  {
    accent: '#5e7f68',
    base: '#eaf1e7',
    night: '#cfd8c9',
    edge: '#3f5c48',
    ink: '#22362b',
    muted: '#607164',
    paper: '#f7fbf3',
  },
  {
    accent: '#5d73a7',
    base: '#e9eef8',
    night: '#cfd6e3',
    edge: '#384d7f',
    ink: '#26334f',
    muted: '#65708e',
    paper: '#f7f9ff',
  },
  {
    accent: '#9a6b51',
    base: '#eee1d0',
    night: '#dcc8b2',
    edge: '#6f4b37',
    ink: '#3c2d24',
    muted: '#766250',
    paper: '#fbf4ea',
  },
  {
    accent: '#6f647c',
    base: '#eee9f0',
    night: '#d7cbdc',
    edge: '#51475e',
    ink: '#332d3c',
    muted: '#74697e',
    paper: '#fbf8fc',
  },
] as const;

export function BookCover({ book, size = 'md' }: BookCoverProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(() => typeof IntersectionObserver === 'undefined');
  const sizedCoverUrl = getBookCoverUrl(book.coverUrl, size === 'xs' || size === 'sm' ? 'small' : size === 'xl' ? 'large' : 'medium');
  const coverResource = useAuthenticatedImageResource(isNearViewport ? sizedCoverUrl : undefined);
  const imageCoverUrl = coverResource.url;
  const isCoverFailed = Boolean(book.coverUrl) && coverResource.status === 'error';
  const shouldUseImageCover = Boolean(imageCoverUrl) && !isCoverFailed;
  const isCoverLoading = isNearViewport && Boolean(book.coverUrl) && coverResource.status === 'loading';
  const compactStatus = size === 'xs' || size === 'sm';
  const statusLabel = isCoverFailed ? '封面加载失败' : '封面加载中';

  useEffect(() => {
    if (isNearViewport || !containerRef.current || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '360px 0px' },
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isNearViewport]);

  const renderContent = () => {
    if (imageCoverUrl && shouldUseImageCover) {
      return (
        <img
          alt={`《${book.title}》封面`}
          className="h-full w-full object-cover bg-white"
          decoding="async"
          loading={size === 'xl' ? 'eager' : 'lazy'}
          fetchPriority={size === 'xl' ? 'high' : 'auto'}
          onError={coverResource.onError}
          src={imageCoverUrl}
        />
      );
    }

    const palette = coverPalettes[getStableIndex(book.id || book.title, coverPalettes.length)];
    const isTiny = size === 'sm' || size === 'xs';
    const title = book.title.trim() || '未命名';
    const author = book.author?.trim() || '佚名';

    return (
      <div
        aria-label={`《${book.title}》默认封面`}
        className="book-cover-placeholder relative h-full w-full overflow-hidden [container-type:inline-size]"
        style={{
          '--cover-paper': palette.base,
          '--cover-night-paper': palette.night,
          '--cover-title-lines': titleLineClamp[size],
          color: palette.ink,
        } as CSSProperties}
      >
        <div className="absolute inset-y-0 left-0 w-[7%]" style={{ backgroundColor: palette.edge }} />
        <div className="absolute inset-y-0 left-[7%] w-px bg-white/40" />
        <div className="absolute inset-y-0 left-[calc(7%+1px)] w-[4%] bg-gradient-to-r from-black/[0.12] to-transparent" />
        <div className="absolute inset-x-[12%] top-[6%] h-px bg-black/10" />
        <div className="book-cover-bottom-rule absolute inset-x-[12%] bottom-[6%] h-px bg-black/10" />

        <div className={cn('book-cover-content relative z-[1] flex h-full flex-col', contentPaddingClass[size])}>
          <div className="flex shrink-0 items-center justify-between gap-2" style={{ color: palette.muted }}>
            <span className={cn('truncate font-medium tracking-normal', metaClass[size])}>{kindLabel[book.kind]}</span>
            {!isTiny && <BookOpenText className="h-3.5 w-3.5 shrink-0 opacity-70" />}
          </div>

          <div className="my-auto min-h-0 py-2">
            <div
              className={cn('book-cover-title overflow-hidden break-words font-display font-semibold tracking-normal', titleClass[size])}
              style={{
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
              }}
            >
              {size === 'xs' ? getShortTitle(book.title) : title}
            </div>
          </div>
          {!isTiny && (
            <div className={cn('book-cover-author shrink-0 truncate', metaClass[size], (isCoverLoading || isCoverFailed) && 'mb-5')} style={{ color: palette.muted }}>
              {author}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'book-cover relative overflow-hidden',
        sizeClass[size],
        `book-cover-${size}`
      )}
    >
      {renderContent()}
      {(isCoverLoading || isCoverFailed) && (
        <span
          aria-label={statusLabel}
          role="img"
          title={statusLabel}
          className={cn(
            'absolute right-1 z-20 rounded',
            compactStatus
              ? cn('top-1 grid place-items-center bg-stone-900/65 text-white/90', size === 'xs' ? 'h-3 w-3' : 'h-4 w-4')
              : cn('bottom-1 max-w-[calc(100%-8px)] truncate px-1.5 py-0.5 text-[10px]', isCoverFailed ? 'bg-amber-100 text-amber-950 dark:bg-stone-900/85 dark:text-amber-200/80' : 'bg-stone-900/70 text-white'),
          )}
        >
          {compactStatus ? (
            isCoverFailed
              ? <ImageOff aria-hidden className={size === 'xs' ? 'h-2 w-2' : 'h-2.5 w-2.5'} />
              : <LoaderCircle aria-hidden className={cn('motion-safe:animate-spin', size === 'xs' ? 'h-2 w-2' : 'h-2.5 w-2.5')} />
          ) : isCoverFailed ? statusLabel : '加载中'}
        </span>
      )}
      

    </div>
  );
}

function getStableIndex(value: string, modulo: number): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash % modulo;
}

function getShortTitle(title: string): string {
  const normalizedTitle = title.trim() || '书';
  const cleanedTitle = normalizedTitle.replace(/[《》\s]/g, '');
  return Array.from(cleanedTitle || normalizedTitle).slice(0, 2).join('');
}
