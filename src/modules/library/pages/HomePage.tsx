import { ArrowRight, BookOpenText, Clock3, Flame, LibraryBig, Play, RefreshCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { useSession } from '../../../app/SessionContext';
import { ROUTES, getBookDetailPath } from '../../../config/routes';
import { Button, EmptyState, LinkButton, Reveal } from '../../../shared/components';
import { BookCover, getBookshelfOverview, getBrowserReaderAvailability, getReaderRouteForBook, invalidateBookListCache, kindLabel } from '../../books';
import type { Book } from '../../books';
import { getBookProgressLabel, hasBookReadingHistory } from '../../books/services/bookProgress';
import { formatReadingProgressPercent } from '../../../shared/utils/readingProgress';
import {
  cloudActivitySummaryToStore,
  formatReadingDuration,
  mergeSecondsStores,
  readReadingActivityStore,
  summarizeReadingActivityStore,
  useCloudReadingActivitySummary,
  ReadingActivityPendingNotice,
  READING_PROGRESS_SAVED_EVENT,
  type PendingReadingActivitySummary,
  type ReadingActivitySummary,
} from '../../reading-progress';
import { BookGrid } from '../components/BookGrid';
import { RecentReadingShelf } from '../components/RecentReadingShelf';
import { SectionHeader } from '../components/SectionHeader';
import type { HomeReadingStats } from '../services/homeStats';
import { isLegacyDesktopShell } from '../../../shared/desktopShell';
import { startPolling } from '../../../shared/utils/polling';
import { TRANSLATED_BOOKS_CHANGED_EVENT } from '../../uploads/services/wholeBookTranslationService';
import { useNavigationSnapshot } from '../../../shared/navigation/useNavigationSnapshot';

interface HomeActivityState {
  pendingActivity: PendingReadingActivitySummary;
  summary: ReadingActivitySummary | null;
  error: string;
  hasCloudSummary: boolean;
  hasLocalActivity: boolean;
  isLoading: boolean;
  retry: () => void;
}

export function HomePage() {
  const { session } = useSession();
  const navigationSnapshot = useNavigationSnapshot();
  const recentReadingScrollLeft = navigationSnapshot?.rails?.['recent-reading'] ?? 0;
  const [books, setBooks] = useState<Book[]>([]);
  const [updatedBooks, setUpdatedBooks] = useState<Book[]>([]);
  const [shelfActivity, setShelfActivity] = useState({ ongoingCount: 0, updateCount: 0 });
  const [continueBook, setContinueBook] = useState<Book | null>(null);
  const [readingStats, setReadingStats] = useState<HomeReadingStats>({ finishedBooks: 0, inProgressBooks: 0, totalBooks: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [booksAccountId, setBooksAccountId] = useState(session?.id);
  const loadedAccountRef = useRef(session?.id);
  const { cloudActivitySummary, activityError, hasActivityLoaded, isActivityLoading, pendingActivity, retryActivity } = useCloudReadingActivitySummary(session?.id, reloadKey);

  useEffect(() => {
    let isMounted = true;

    // Keep the current account's shelf visible during a confirmed-progress refresh.
    if (loadedAccountRef.current !== session?.id) {
      setBooks([]);
      setUpdatedBooks([]);
      setShelfActivity({ ongoingCount: 0, updateCount: 0 });
      setContinueBook(null);
      setReadingStats({ finishedBooks: 0, inProgressBooks: 0, totalBooks: 0 });
    }
    loadedAccountRef.current = session?.id;
    setBooksAccountId(session?.id);

    const stop = startPolling(async (signal) => {
      setIsLoading(true);
      setLoadError('');
      // Resume and publication events must read through the short-lived cache.
      invalidateBookListCache();
      try {
        const overview = await getBookshelfOverview(false, signal);
        if (isMounted && !signal.aborted) {
          setBooks(overview.books);
          setUpdatedBooks(overview.updatedBooks);
          setShelfActivity({ ongoingCount: overview.ongoingCount, updateCount: overview.sourceUpdateCount });
          setContinueBook(overview.continueBook);
          setReadingStats({ finishedBooks: overview.finishedCount, inProgressBooks: overview.inProgressCount, totalBooks: overview.total });
        }
      } catch (error: unknown) {
        if (isMounted && !signal.aborted) {
          setLoadError(error instanceof Error && error.message ? error.message : '书架加载失败');
        }
      } finally {
        if (isMounted && !signal.aborted) {
          setIsLoading(false);
        }
      }
    }, { events: ['focus', READING_PROGRESS_SAVED_EVENT, TRANSLATED_BOOKS_CHANGED_EVENT] });

    return () => {
      isMounted = false;
      stop();
    };
  }, [reloadKey, session?.id]);

  const localActivityStore = readReadingActivityStore();
  const hasLocalActivity = Object.values(localActivityStore).some((seconds) => seconds > 0);
  const activityStore = mergeSecondsStores(cloudActivitySummaryToStore(cloudActivitySummary), localActivityStore);
  const activity: HomeActivityState = {
    pendingActivity,
    summary: hasActivityLoaded || hasLocalActivity ? summarizeReadingActivityStore(activityStore) : null,
    error: activityError,
    hasCloudSummary: Boolean(cloudActivitySummary),
    hasLocalActivity,
    isLoading: isActivityLoading,
    retry: retryActivity,
  };
  // The overview endpoint already orders these by actual reading activity.
  // Re-sorting by a book's metadata timestamp makes a freshly read title fall
  // behind an older upload, which is the opposite of what a personal home
  // screen should do.
  const recentBooks = books.slice(0, 12);
  const heroBook = continueBook ?? recentBooks[0];

  if (booksAccountId !== session?.id || (isLoading && books.length === 0)) {
    return <HomeSkeleton />;
  }

  if (loadError && books.length === 0) {
    return (
      <Reveal>
        <EmptyState
          action={<Button onClick={() => setReloadKey((currentKey) => currentKey + 1)}>重试</Button>}
          description={loadError}
          title="书架加载失败"
        />
      </Reveal>
    );
  }

  if (books.length === 0) {
    return (
      <Reveal>
        <HomeEmptyStage />
      </Reveal>
    );
  }

  const refreshNotice = loadError ? (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm" role="alert">
      <p className="text-stone-500 dark:text-night-soft">书架更新失败，已保留上次内容。</p>
      <Button onClick={() => setReloadKey((current) => current + 1)} variant="secondary">重试</Button>
    </div>
  ) : null;

  if (isLegacyDesktopShell()) {
    return (
      <>
        {refreshNotice}
        <CompactHomePage
          activity={activity}
          activeCount={readingStats.inProgressBooks}
          books={books}
          continueBook={heroBook}
          readingStats={readingStats}
          recentReadingScrollLeft={recentReadingScrollLeft}
          shelfActivity={shelfActivity}
          updatedBooks={updatedBooks}
        />
      </>
    );
  }

  return (
    <div className="space-y-9 sm:space-y-12">
      {refreshNotice}
      {heroBook && (
        <Reveal>
          <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <ReadingNowHero book={heroBook} />
            <HomeDashboard
              activity={activity}
              activeCount={readingStats.inProgressBooks}
              ongoingCount={shelfActivity.ongoingCount}
              readingStats={readingStats}
              updateCount={shelfActivity.updateCount}
            />
          </div>
        </Reveal>
      )}

      <Reveal>
        <RecentReadingShelf books={recentBooks} initialScrollLeft={recentReadingScrollLeft} />
      </Reveal>

      {updatedBooks.length > 0 && (
        <Reveal>
          <section>
            <SectionHeader
              action={
                <Link className="inline-flex min-h-10 items-center text-sm text-ink/45 transition hover:text-accent dark:text-stone-500 dark:hover:text-accent-soft" to={ROUTES.library}>
                  查看书架 →
                </Link>
              }
              index="02"
              title="连载有新页"
            />
            <div className="mt-6">
              <BookGrid books={updatedBooks} compact />
            </div>
          </section>
        </Reveal>
      )}

      <Reveal>
        <p className="pb-4 pt-2 text-center text-[11px] tracking-[0.3em] text-ink/40 tabular-nums dark:text-stone-500">
          爱素书屋 · {readingStats.totalBooks} 册
        </p>
      </Reveal>
    </div>
  );
}

function CompactHomePage({
  activity,
  activeCount,
  books,
  continueBook,
  readingStats,
  recentReadingScrollLeft,
  shelfActivity,
  updatedBooks,
}: {
  activity: HomeActivityState;
  activeCount: number;
  books: Book[];
  continueBook: Book | null;
  readingStats: HomeReadingStats;
  recentReadingScrollLeft: number;
  shelfActivity: { ongoingCount: number; updateCount: number };
  updatedBooks: Book[];
}) {
  const recentBooks = books.slice(0, 12);
  const heroBook = continueBook ?? recentBooks[0];

  return (
    <div className="home-compact-page space-y-7 sm:space-y-9 lg:space-y-5">
      <div className="flex items-end justify-between gap-4 border-b border-ink/10 pb-3 dark:border-white/10">
        <h1 className="app-page-title flex min-w-0 items-center gap-2.5 font-display text-2xl font-semibold tracking-tight text-stone-950 lg:text-xl sm:text-3xl dark:text-night-ink">
          <LibraryBig className="h-5 w-5 shrink-0 text-accent sm:h-6 sm:w-6 dark:text-accent-soft" />
          <span>我的阅读</span>
        </h1>
        <Link className="shrink-0 text-sm text-ink/55 transition hover:text-accent dark:text-stone-400 dark:hover:text-accent-soft" to={ROUTES.library}>
          全部图书 <ArrowRight className="mb-0.5 inline h-4 w-4" />
        </Link>
      </div>

      {heroBook && <CompactReadingHero book={heroBook} />}

      <CompactHomeDashboard
        activity={activity}
        activeCount={activeCount}
        ongoingCount={shelfActivity.ongoingCount}
        readingStats={readingStats}
        updateCount={shelfActivity.updateCount}
      />

      <RecentReadingShelf books={recentBooks} initialScrollLeft={recentReadingScrollLeft} />

      {updatedBooks.length > 0 && (
        <section>
          <SectionHeader action={<Link className="text-sm text-ink/55 hover:text-accent dark:text-stone-400 dark:hover:text-accent-soft" to={ROUTES.library}>查看书架 →</Link>} index="02" title="连载有新页" />
          <div className="mt-6">
            <BookGrid books={updatedBooks} compact />
          </div>
        </section>
      )}
    </div>
  );
}

function CompactReadingHero({ book }: { book: Book }) {
  const navigationState = createCollectionLinkState(useLocation());
  const availability = getBrowserReaderAvailability(book);
  const readerPath = availability.canReadInBrowser ? getReaderRouteForBook(book) : availability.entryPath;
  const hasProgress = hasBookReadingHistory(book);
  const progressPercent = Math.max(0, Math.min(100, book.progressPercent));
  const author = book.author?.trim() || '佚名';

  return (
    <section className="home-compact-hero reading-feature">
      <div className="reading-feature-content">
        <div className="reading-feature-meta">
          <span className="home-reading-label"><BookOpenText aria-hidden /> {progressPercent >= 100 ? '已经读完' : hasProgress ? '正在阅读' : '待阅读'}</span>
          <span>{kindLabel[book.kind]}</span>
          {book.tags.slice(0, 1).map((tag) => <span key={tag}>· {tag}</span>)}
        </div>
        <h2>{book.title}</h2>
        <p className="reading-feature-author">{author}</p>
        {book.description && <p className="reading-feature-description">{book.description}</p>}
        <div className="reading-feature-footer">
          <div className="home-compact-actions">
            <LinkButton icon={availability.canReadInBrowser ? <Play className="h-4 w-4 fill-current" /> : <ArrowRight className="h-4 w-4" />} title={availability.reason} state={navigationState} to={readerPath}>
              {availability.canReadInBrowser ? (hasProgress ? '继续阅读' : '开始阅读') : '查看详情'}
            </LinkButton>
            {availability.canReadInBrowser && <Link className="reading-feature-details" state={navigationState} to={getBookDetailPath(book.id)}>图书详情 <ArrowRight aria-hidden /></Link>}
          </div>
          <div className="reading-feature-progress">
            <div><span>{book.currentChapter || '阅读进度'}</span><span>{getBookProgressLabel(book.progressPercent, book.lastReadAt).label}</span></div>
            <div aria-hidden className="reading-feature-track"><span style={{ width: `${Math.max(0, Math.min(100, book.progressPercent))}%` }} /></div>
          </div>
        </div>
      </div>
      <Link aria-label={`《${book.title}》封面`} className="reading-feature-cover" state={navigationState} to={getBookDetailPath(book.id)}>
        <BookCover book={book} size="md" />
      </Link>
    </section>
  );
}

function getActivityFigures(summary: ReadingActivitySummary | null) {
  return [
    { icon: Clock3, label: '今天读了', value: summary ? formatReadingDuration(summary.todaySeconds) : '—' },
    { icon: Flame, label: '连续阅读', value: summary ? `${summary.streakDays} 天` : '—' },
    { icon: BookOpenText, label: '本周阅读', value: summary ? formatReadingDuration(summary.weekSeconds) : '—' },
  ];
}

function HomeActivityFeedback({ activity }: { activity: HomeActivityState }) {
  if (activity.pendingActivity.eventCount > 0) return <ReadingActivityPendingNotice className="px-4" isLoading={activity.isLoading} loadFailed={Boolean(activity.error)} onRetry={activity.retry} pending={activity.pendingActivity} />;
  if (!activity.isLoading && !activity.error) return null;
  const message = activity.error
    ? activity.hasCloudSummary ? '云端更新失败，已保留上次统计。' : activity.hasLocalActivity ? '云端记录未取得，暂显示此设备记录。' : '阅读统计暂时无法读取。'
    : activity.summary ? '正在更新阅读统计…' : '正在读取阅读统计…';
  return (
    <div className="home-activity-feedback flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 text-xs leading-5 text-stone-500 dark:text-stone-400">
      <p className="min-w-0 flex-1" role={activity.error ? 'alert' : 'status'}>{message}</p>
      {activity.error && <button aria-label="重试阅读统计" className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-1 font-medium text-accent hover:underline dark:text-accent-soft" onClick={activity.retry} type="button"><RefreshCcw aria-hidden className="h-3.5 w-3.5" />重试</button>}
    </div>
  );
}

function CompactHomeDashboard({ activity, activeCount, ongoingCount, readingStats, updateCount }: { activity: HomeActivityState; activeCount: number; ongoingCount: number; readingStats: HomeReadingStats; updateCount: number }) {
  const items = [
    ...getActivityFigures(activity.summary),
    { icon: LibraryBig, label: '我的藏书', value: `${readingStats.totalBooks} 本` },
  ];

  return (
    <div className="reading-summary">
      <div className="min-w-0">
        <Link className="reading-summary-stats" to={ROUTES.profile} aria-label="查看阅读统计">
          {items.map(({ icon: Icon, label, value }) => (
            <span className="reading-summary-stat" key={label}>
              <span className="reading-summary-label"><Icon aria-hidden />{label}</span>
              <span aria-busy={label !== '我的藏书' && activity.isLoading} aria-label={value === '—' ? `${label} 暂未取得数据` : undefined} className="reading-summary-value">
                {value.split(/(?<=小时) /).map((part) => <span key={part}>{part}</span>)}
              </span>
            </span>
          ))}
        </Link>
        <HomeActivityFeedback activity={activity} />
      </div>
      <Link className="reading-summary-news" to={ROUTES.library}>
        <div><span className="reading-summary-label">书架动态</span><strong>{updateCount > 0 ? `${updateCount} 话新内容` : '暂无新章节'}</strong></div>
        <ArrowRight aria-hidden />
        <p>在读 {activeCount}<span>连载 {ongoingCount}</span><span>读完 {readingStats.finishedBooks}</span></p>
      </Link>
    </div>
  );
}

function HomeEmptyStage() {
  return (
    <section className="home-empty-stage relative isolate min-h-[480px] overflow-hidden rounded-[2rem] border border-ink/[0.08] dark:border-white/[0.08]">
      <div className="relative z-10 flex min-h-[480px] items-end p-6 sm:p-10">
        <div className="max-w-sm p-5 text-ink dark:text-night-ink">
          <p className="mt-2 font-display text-2xl font-semibold">书架还没有书</p>
          <LinkButton className="mt-5" icon={<BookOpenText className="h-4 w-4" />} to={ROUTES.upload} variant="primary">
            上传第一本
          </LinkButton>
        </div>
      </div>
    </section>
  );
}

function ReadingNowHero({ book }: { book: Book }) {
  const navigationState = createCollectionLinkState(useLocation());
  const availability = getBrowserReaderAvailability(book);
  const readerPath = availability.canReadInBrowser ? getReaderRouteForBook(book) : availability.entryPath;
  const hasProgress = hasBookReadingHistory(book);
  const progressPercent = Math.max(0, Math.min(100, book.progressPercent));
  const author = book.author?.trim() || '佚名';

  return (
    <section className="home-hero-card relative isolate flex min-h-[330px] items-center overflow-hidden sm:min-h-[370px]">
      <div className="relative z-10 grid w-full grid-cols-[80px_minmax(0,1fr)] items-center gap-x-4 gap-y-5 p-5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-x-7 sm:px-8 sm:py-9 2xl:grid-cols-[180px_minmax(0,1fr)]">
        <Link
          className="home-hero-cover group mx-auto block w-20 shrink-0 sm:row-span-2 sm:w-[150px] 2xl:w-[180px]"
          state={navigationState}
          to={getBookDetailPath(book.id)}
        >
          <BookCover book={book} />
        </Link>

        <div className="min-w-0 text-left">
          <div className="mb-3 flex flex-wrap items-center justify-start gap-2 text-xs font-medium text-white/75 sm:mb-4">
            <span className="home-reading-label inline-flex items-center gap-1.5 py-1.5 text-peach"><BookOpenText className="h-3.5 w-3.5" /> {hasProgress ? (progressPercent >= 100 ? '已经读完' : '正在阅读') : '待阅读'}</span>
            <span>{kindLabel[book.kind]}</span>
            {book.tags.slice(0, 1).map((tag) => <span key={tag}>· {tag}</span>)}
          </div>
          <h2 className="font-display text-[1.35rem] font-semibold leading-[1.4] tracking-tight text-white line-clamp-4 sm:text-[clamp(1.8rem,2.5vw,2.75rem)] sm:line-clamp-3">
              {book.title}
          </h2>
          <p className="mt-3 text-sm text-white/80">{author}</p>
          {book.description && <p className="home-hero-description mt-4 hidden max-w-2xl text-sm leading-7 text-white/75 sm:line-clamp-2">{book.description}</p>}

        </div>
        <div className="col-span-2 min-w-0 sm:col-span-1 sm:col-start-2">
          <div className="max-w-2xl">
            <div className="flex items-baseline justify-between gap-4 text-xs text-white/80">
              <span className="truncate">{book.currentChapter || (hasProgress ? '阅读进度' : '未开始')}</span>
              {hasProgress && <span className="shrink-0 font-semibold tabular-nums text-peach">{formatReadingProgressPercent(progressPercent)}</span>}
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/20">
              <div className="home-progress-glow h-full rounded-full bg-peach" style={{ width: `${hasProgress ? progressPercent : 0}%` }} />
            </div>
          </div>

          <div className="mt-5 flex flex-wrap justify-start gap-2 sm:gap-3">
            <LinkButton className="min-h-11 px-4 sm:px-6" icon={availability.canReadInBrowser ? <Play className="h-4 w-4 fill-current" /> : <ArrowRight className="h-4 w-4" />} title={availability.reason} state={navigationState} to={readerPath}>
              {availability.canReadInBrowser ? (hasProgress ? '继续阅读' : '开始阅读') : '查看详情'}
            </LinkButton>
            {availability.canReadInBrowser && (
              <Link className="inline-flex min-h-11 items-center gap-1.5 rounded-2xl px-2.5 text-xs font-medium text-white/80 transition hover:bg-white/10 hover:text-white sm:gap-2 sm:px-4 sm:text-sm" state={navigationState} to={getBookDetailPath(book.id)}>
                <span className="hidden xs:inline">图书详情</span><span className="xs:hidden">详情</span> <ArrowRight className="h-4 w-4" />
              </Link>
            )}
          </div>
        </div>

      </div>
    </section>
  );
}

function HomeDashboard({ activity, activeCount, ongoingCount, readingStats, updateCount }: { activity: HomeActivityState; activeCount: number; ongoingCount: number; readingStats: HomeReadingStats; updateCount: number }) {
  const items = [
    ...getActivityFigures(activity.summary),
    { icon: LibraryBig, label: '我的藏书', value: `${readingStats.totalBooks} 本` },
  ];

  return (
    <aside className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
      <section className="home-dashboard-card group p-1 transition">
        <Link className="block" to={ROUTES.profile}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-xl font-semibold text-stone-950 dark:text-night-ink">阅读统计</h2>
            </div>
            <ArrowRight className="h-4 w-4 text-ink/30 transition-transform group-hover:translate-x-1 dark:text-white/30" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-ink/10 pt-4 dark:border-white/10">
            {items.map(({ icon: Icon, label, value }) => (
              <span className="min-w-0" key={label}>
                <Icon className="mb-2 h-4 w-4 text-accent dark:text-accent-soft/70" />
                <span className="block text-xs text-ink/65 dark:text-stone-400">{label}</span>
                <span aria-busy={label !== '我的藏书' && activity.isLoading} aria-label={value === '—' ? `${label} 暂未取得数据` : undefined} className="mt-1 flex flex-wrap gap-x-1 font-display text-lg font-semibold leading-relaxed tabular-nums text-stone-950 dark:text-night-ink">
                  {value.split(/(?<=小时) /).map((part) => <span className="whitespace-nowrap" key={part}>{part}</span>)}
                </span>
              </span>
            ))}
          </div>
        </Link>
        <HomeActivityFeedback activity={activity} />
      </section>

      <Link className="home-news-card group relative isolate overflow-hidden p-1" to={ROUTES.library}>
        <div aria-hidden className="absolute -right-12 -top-14 h-40 w-40 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative z-10">
          <div className="flex items-center justify-between">
            <span className="grid h-9 w-9 place-items-center"><RefreshCcw className="h-4 w-4 text-accent-soft" /></span>
            <ArrowRight className="h-4 w-4 text-white/35 transition-transform group-hover:translate-x-1" />
          </div>
          <p className="mt-4 text-xs text-white/75">书架动态</p>
          <p className="mt-1 font-display text-2xl font-semibold">{updateCount > 0 ? `${updateCount} 话新内容` : '暂无新章节'}</p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-white/80">
            <span>在读 {activeCount}</span>
            <span>连载 {ongoingCount}</span>
            <span>读完 {readingStats.finishedBooks}</span>
          </div>
        </div>
      </Link>
    </aside>
  );
}

function HomeSkeleton() {
  const placeholder = 'bg-stone-900/5 dark:bg-white/[0.05]';
  return (
    <div aria-busy="true" data-navigation-loading="true" role="status" className="home-compact-page space-y-7 motion-safe:animate-pulse sm:space-y-9 lg:space-y-5">
      <div className="flex items-end justify-between gap-4 border-b border-ink/10 pb-3 dark:border-white/10">
        <span className="sr-only">正在读取书架…</span>
        <div className={`h-7 w-32 rounded ${placeholder}`} />
        <div className={`h-4 w-20 rounded ${placeholder}`} />
      </div>
      <div aria-hidden="true" className="home-compact-hero reading-feature">
        <div className="reading-feature-content">
          <div className={`h-[18px] w-28 rounded ${placeholder}`} />
          <div className={`mt-2 h-8 w-3/4 rounded ${placeholder}`} />
          <div className={`reading-feature-author h-[18px] w-24 rounded ${placeholder}`} />
          <div className={`reading-feature-description h-[22px] w-full rounded ${placeholder}`} />
          <div className="reading-feature-footer">
            <div className="home-compact-actions">
              <div className={`h-11 w-28 rounded-xl sm:h-10 ${placeholder}`} />
              <div className={`h-11 w-20 rounded-xl sm:h-10 ${placeholder}`} />
            </div>
            <div className="reading-feature-progress">
              <div><span className={`h-3 w-20 rounded ${placeholder}`} /><span className={`h-3 w-8 rounded ${placeholder}`} /></div>
              <div className="reading-feature-track" />
            </div>
          </div>
        </div>
        <div className="reading-feature-cover"><div className={`aspect-[0.68] rounded-xl ${placeholder}`} /></div>
      </div>
      <div aria-hidden="true" className="reading-summary">
        <div className="reading-summary-stats">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="reading-summary-stat" key={index}>
              <div className={`h-[18px] w-2/3 rounded ${placeholder}`} />
              <div className={`mt-[3px] h-6 w-3/4 rounded ${placeholder}`} />
            </div>
          ))}
        </div>
        <div className="reading-summary-news">
          <div className={`h-5 w-4/5 rounded ${placeholder}`} />
          <div className={`col-span-2 h-4 w-3/4 rounded ${placeholder}`} />
        </div>
      </div>
      <section aria-hidden="true" className="recent-reading-shelf">
        <div className="recent-reading-heading"><div className={`h-[30px] w-24 rounded ${placeholder}`} /></div>
        <div className="recent-cover-rail">
          {Array.from({ length: 8 }).map((_, index) => (
            <div className="recent-cover-entry" key={index}>
              <div className={`aspect-[0.68] rounded-xl ${placeholder}`} />
              <div className="mt-2.5 h-[2.9em] space-y-1.5 text-[13px]">
                <div className={`h-3.5 rounded ${placeholder}`} />
                <div className={`h-3.5 w-2/3 rounded ${placeholder}`} />
              </div>
              <div className={`mt-[5px] h-4 w-3/4 rounded ${placeholder}`} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
