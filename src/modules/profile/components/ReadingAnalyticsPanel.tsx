import { BookMarked, Sparkles, Target, TrendingDown, TrendingUp } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Panel } from '../../../shared/components/Panel';
import { HAIRLINE, LABEL } from '../../../shared/ui';
import { cn } from '../../../shared/utils/cn';
import type { Book } from '../../books';
import { SectionHeader } from '../../library/components/SectionHeader';
import {
  cloudActivitySummaryToBookTimeStore,
  cloudActivitySummaryToStore,
  formatReadingDuration,
  readBookReadingTimeStore,
  mergeSecondsStores,
  readReadingActivityStore,
  summarizeReadingActivityStore,
  useCloudReadingActivitySummary,
  ReadingActivityPendingNotice,
} from '../../reading-progress';
import { buildReadingPortrait, type ReadingPortrait } from '../services/readingPortrait';
import { getRecommendedWeeklyGoal, getWeeklyGoalStorageKey, hasStoredWeeklyGoal, readWeeklyGoal, WEEKLY_GOAL_OPTIONS, writeWeeklyGoal } from '../services/weeklyReadingGoal';
import { ProfileResourceFeedback } from './ProfileResourceFeedback';

type AnalyticsTab = 'overview' | 'week' | 'month';

const TAB_LABELS: Record<AnalyticsTab, string> = {
  overview: '总览',
  week: '近7天',
  month: '月度热力',
};

interface ReadingAnalyticsPanelProps {
  accountId?: string;
  books: Array<Pick<Book, 'id' | 'title'>>;
}

/**
 * The reading analytics dashboard (daily/weekly bars, month heatmap, streaks,
 * top books) — moved here from the former home hero so the profile page is
 * the single home of detailed stats.
 */
export function ReadingAnalyticsPanel({ accountId, books }: ReadingAnalyticsPanelProps) {
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('overview');
  const tabsId = useId();
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const { cloudActivitySummary, activityError, hasActivityLoaded, isActivityLoading, pendingActivity, retryActivity } = useCloudReadingActivitySummary(accountId);
  const [weeklyGoal, setWeeklyGoal] = useState(() => ({ accountId, hours: readWeeklyGoal(accountId) }));
  const weeklyGoalHours = weeklyGoal.accountId === accountId ? weeklyGoal.hours : readWeeklyGoal(accountId);

  useEffect(() => {
    setWeeklyGoal({ accountId, hours: readWeeklyGoal(accountId) });
    setSelectedDateKey(null);
    const refreshGoal = (event: StorageEvent) => {
      if (!event.key || event.key === getWeeklyGoalStorageKey(accountId)) setWeeklyGoal({ accountId, hours: readWeeklyGoal(accountId) });
    };
    window.addEventListener('storage', refreshGoal);
    return () => window.removeEventListener('storage', refreshGoal);
  }, [accountId]);

  const localActivityStore = readReadingActivityStore();
  const hasLocalActivity = Object.values(localActivityStore).some((seconds) => seconds > 0);
  const canShowActivity = hasActivityLoaded || hasLocalActivity;
  const activityStore = mergeSecondsStores(cloudActivitySummaryToStore(cloudActivitySummary), localActivityStore);
  const cloudBookReadingTimeStore = cloudActivitySummaryToBookTimeStore(cloudActivitySummary);
  const localBookReadingTimeStore = readBookReadingTimeStore();
  const now = new Date();
  const activitySummary = summarizeReadingActivityStore(activityStore, now);
  const getMergedBookReadingTime = (bookId: string) => Math.max(localBookReadingTimeStore[bookId] ?? 0, cloudBookReadingTimeStore[bookId] ?? 0);

  const last7Days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - index));
    const key = formatDateKey(date);
    const seconds = activityStore[key] ?? 0;
    return { dateKey: key, label: ['日', '一', '二', '三', '四', '五', '六'][date.getDay()], seconds };
  });
  const maxSeconds = Math.max(...last7Days.map((day) => day.seconds), 30 * 60);
  const weeklySeconds = last7Days.reduce((total, day) => total + day.seconds, 0);
  const weeklyActiveDays = last7Days.filter((day) => day.seconds > 0).length;
  const weeklyAverageSeconds = weeklyActiveDays > 0 ? weeklySeconds / weeklyActiveDays : 0;
  const bestDay = last7Days.reduce((best, day) => (day.seconds > best.seconds ? day : best), last7Days[0]);

  const allActivityDays = Object.entries(activityStore)
    .map(([dateKey, seconds]) => ({ dateKey, seconds }))
    .filter((day) => day.seconds > 0)
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey));
  const firstReadDate = allActivityDays[0]?.dateKey ?? null;
  const latestReadDate = allActivityDays.at(-1)?.dateKey ?? null;
  const lifetimeActiveDays = allActivityDays.length;
  const lifetimeAverageSeconds = lifetimeActiveDays > 0 ? activitySummary.totalSeconds / lifetimeActiveDays : 0;
  const bestLifetimeDay = allActivityDays.reduce(
    (best, day) => (day.seconds > best.seconds ? day : best),
    allActivityDays[0] ?? { dateKey: '', seconds: 0 },
  );
  const longestStreakDays = getLongestReadingStreakDays(allActivityDays.map((day) => day.dateKey));
  const currentBookIds = new Set(books.map((book) => book.id));
  const deletedBookHistory = (cloudActivitySummary?.book_totals ?? [])
    .filter((total) => !currentBookIds.has(total.book_id) && total.seconds > 0)
    .map((total) => ({
      book: { id: total.book_id, title: total.book_title || '已删除图书' },
      seconds: total.seconds,
    }));
  const booksByReadingTime = [
    ...books.map((book) => ({ book, seconds: getMergedBookReadingTime(book.id) })),
    ...deletedBookHistory,
  ]
    .filter(({ seconds }) => seconds > 0)
    .sort((left, right) => right.seconds - left.seconds);
  const topBooksByReadingTime = booksByReadingTime.slice(0, 3);
  const readingPortrait = buildReadingPortrait(
    activityStore,
    booksByReadingTime.map(({ book, seconds }) => ({ bookId: book.id, seconds, title: book.title })),
    now,
  );

  useEffect(() => {
    if (cloudActivitySummary && !hasStoredWeeklyGoal(accountId)) {
      setWeeklyGoal({ accountId, hours: getRecommendedWeeklyGoal(readingPortrait.previousWeekSeconds || readingPortrait.weekSeconds) });
    }
  }, [accountId, cloudActivitySummary, readingPortrait.previousWeekSeconds, readingPortrait.weekSeconds]);

  const calendarDays = getCalendarDays(activityStore, now);
  const selectedDay = calendarDays.find((day) => day.dateKey === selectedDateKey)
    ?? calendarDays.find((day) => day.dateKey === formatDateKey(now));

  const headlineFigures = [
    ['今日', activitySummary.todaySeconds > 0 ? formatReadingDuration(activitySummary.todaySeconds) : '0 分钟'],
    ['连续', `${activitySummary.streakDays} 天`],
    ['本周', formatReadingDuration(activitySummary.weekSeconds)],
    ['累计', formatReadingDuration(activitySummary.totalSeconds)],
  ] as const;

  return (
    <Panel className="reading-analytics-panel">
      <SectionHeader
        className="flex-wrap [&>div:last-child]:max-w-full"
        action={
          <div aria-label="阅读统计视图" role="tablist" className="flex flex-wrap items-center gap-2 sm:gap-4" onKeyDown={(event) => navigateChoices(event, '[role=tab]')}>
            {(Object.keys(TAB_LABELS) as AnalyticsTab[]).map((tab) => (
              <button
                className={cn(
                  'min-h-11 min-w-11 border-b-2 px-2 text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:text-sm dark:focus-visible:outline-peach',
                  activeTab === tab
                    ? 'border-accent font-semibold text-accent dark:border-peach dark:text-peach'
                    : 'border-transparent text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-night-copy',
                )}
                aria-selected={activeTab === tab}
                aria-controls={`${tabsId}-panel`}
                id={`${tabsId}-${tab}`}
                role="tab"
                tabIndex={activeTab === tab ? 0 : -1}
                key={tab}
                onClick={() => setActiveTab(tab)}
                type="button"
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>
        }
        title="阅读统计"
      />

      {pendingActivity.eventCount > 0
        ? <ReadingActivityPendingNotice className="mt-4" isLoading={isActivityLoading} loadFailed={Boolean(activityError)} onRetry={retryActivity} pending={pendingActivity} />
        : <ProfileResourceFeedback label="阅读统计" error={activityError} isLoading={isActivityLoading} hasData={Boolean(cloudActivitySummary)} onRetry={retryActivity} fallbackMessage={!cloudActivitySummary && hasLocalActivity ? '云端记录暂未取得，当前显示此设备已保存的阅读记录。' : undefined} />}
      <div aria-labelledby={`${tabsId}-${activeTab}`} id={`${tabsId}-panel`} role="tabpanel" tabIndex={0} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent dark:focus-visible:outline-peach">
      {canShowActivity && <>
      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-y-8 lg:mt-4 lg:gap-y-5">
        {headlineFigures.map(([label, value]) => (
          <div className="min-w-0 border-l border-accent/25 pl-4 sm:pl-5" key={label}>
            <div className="break-words font-display text-3xl font-medium leading-tight tabular-nums text-stone-950 sm:text-4xl lg:text-2xl dark:text-night-ink">
              {value}
            </div>
            <div className={cn('mt-3', LABEL)}>{label}</div>
          </div>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="animate-fade-in motion-reduce:animate-none">
          <ReadingPortraitSection
            goalHours={weeklyGoalHours}
            onGoalChange={(hours) => {
              setWeeklyGoal({ accountId, hours });
              writeWeeklyGoal(accountId, hours);
            }}
            portrait={readingPortrait}
          />

          <div className="mt-8 grid gap-x-10 gap-y-8 lg:mt-5 lg:gap-x-6 lg:gap-y-5 lg:grid-cols-2">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-5 text-sm">
              <OverviewField label="记录天数" value={`${lifetimeActiveDays} 天`} />
              <OverviewField label="最长连续" value={`${longestStreakDays} 天`} />
              <OverviewField label="开始记录" value={firstReadDate ? formatDateKeyLabel(firstReadDate) : '暂无'} />
              <OverviewField label="最近记录" value={latestReadDate ? formatDateKeyLabel(latestReadDate) : '暂无'} />
              <OverviewField label="活跃日均" value={formatReadingDuration(lifetimeAverageSeconds)} />
              <OverviewField
                label="最佳单日"
                value={bestLifetimeDay.seconds > 0 ? `${formatReadingDuration(bestLifetimeDay.seconds)} · ${formatDateKeyLabel(bestLifetimeDay.dateKey)}` : '暂无'}
              />
            </dl>

            <div>
              <div className={cn('flex items-baseline justify-between border-b pb-2', HAIRLINE)}>
                <span className="text-sm font-medium text-stone-800 dark:text-night-copy">读得最久的书</span>
                <span className={LABEL}>累计时长</span>
              </div>
              <div className="mt-4 space-y-3.5">
                {topBooksByReadingTime.length > 0 ? (
                  topBooksByReadingTime.map(({ book, seconds }, index) => {
                    const maxBookSeconds = topBooksByReadingTime[0]?.seconds ?? seconds;
                    const widthPercent = Math.max(8, (seconds / maxBookSeconds) * 100);
                    return (
                      <div key={book.id}>
                        <div className="flex items-baseline justify-between gap-3 text-xs">
                          <span className="min-w-0 truncate text-stone-700 dark:text-night-copy" title={book.title}>
                            <span className="mr-2 font-display tabular-nums text-ink/40 dark:text-stone-500">{index + 1}</span>
                            {book.title}
                          </span>
                          <span className="shrink-0 tabular-nums text-stone-500 dark:text-stone-400">{formatReadingDuration(seconds)}</span>
                        </div>
                        <div className="mt-1.5 h-px bg-ink/10 dark:bg-white/10">
                          <div className="h-px bg-accent dark:bg-peach" style={{ width: `${widthPercent}%` }} />
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-xs text-stone-500 dark:text-stone-400">暂无记录</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'week' && (
        <div className="mt-8 animate-fade-in motion-reduce:animate-none">
          <div className={cn('flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b pb-2', HAIRLINE)}>
            <span className="text-sm font-medium text-stone-800 dark:text-night-copy">近 7 天</span>
            <span className="min-w-0 text-xs leading-relaxed tabular-nums text-stone-500 dark:text-stone-400">
              峰值 {formatReadingDuration(bestDay.seconds)} · 活跃 {weeklyActiveDays}/7 天 · 日均 {formatReadingDuration(weeklyAverageSeconds)}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-[1.5rem_minmax(0,1fr)_fit-content(45%)] items-center gap-x-3 gap-y-2.5" role="list" aria-label="近7天每日阅读时长">
            {last7Days.map((day, index) => {
              const isToday = index === last7Days.length - 1;
              const hasActivity = day.seconds > 0;
              const widthPercent = hasActivity ? Math.max(4, (day.seconds / maxSeconds) * 100) : 0;
              return (
                <div className="contents" key={day.dateKey} role="listitem" aria-label={`${day.dateKey}，阅读 ${formatReadingDuration(day.seconds)}`}>
                  <span
                    className={cn(
                      'text-center text-xs',
                      isToday ? 'font-semibold text-accent dark:text-peach' : 'text-stone-500 dark:text-stone-400',
                    )}
                  >
                    {day.label}
                  </span>
                  <div className="h-1 bg-ink/[0.07] dark:bg-white/[0.07]">
                    <div
                      className={cn('h-1 transition-all duration-500 motion-reduce:transition-none', hasActivity && 'bg-accent dark:bg-peach')}
                      style={{ width: `${widthPercent}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      'break-words text-right text-xs tabular-nums',
                      hasActivity ? 'font-medium text-stone-700 dark:text-night-copy' : 'text-stone-400 dark:text-stone-500',
                    )}
                  >
                    {formatReadingDuration(day.seconds)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'month' && (
        <div className="mt-8 animate-fade-in motion-reduce:animate-none">
          <div className={cn('flex items-baseline justify-between border-b pb-2', HAIRLINE)}>
            <span className="text-sm font-medium text-stone-800 dark:text-night-copy">{now.getMonth() + 1} 月</span>
            <span className={LABEL}>每日时长</span>
          </div>
          <div className="mt-4">
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-stone-400 dark:text-stone-500">
              <span>日</span>
              <span>一</span>
              <span>二</span>
              <span>三</span>
              <span>四</span>
              <span>五</span>
              <span>六</span>
            </div>
            <div className="mt-2 grid grid-cols-7 justify-items-center gap-1.5" role="group" aria-label="每日阅读记录" onKeyDown={navigateCalendarDays}>
              {calendarDays.map((dayCell, index) => {
                const hasActivity = dayCell.seconds > 0;
                let backgroundClass = 'bg-ink/[0.05] dark:bg-white/[0.06]';
                if (hasActivity) {
                  if (dayCell.seconds < 15 * 60) backgroundClass = 'bg-accent/25 dark:bg-peach/25';
                  else if (dayCell.seconds < 30 * 60) backgroundClass = 'bg-accent/60 dark:bg-peach/60';
                  else backgroundClass = 'bg-accent dark:bg-peach';
                }

                return (
                  <button
                    aria-label={`${dayCell.dateKey}，阅读 ${formatReadingDuration(dayCell.seconds)}`}
                    aria-pressed={selectedDay?.dateKey === dayCell.dateKey}
                    className="reading-calendar-day flex min-h-8 w-full min-w-0 items-center justify-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent dark:focus-visible:outline-peach"
                    key={`${dayCell.dateKey}-${index}`}
                    onClick={() => setSelectedDateKey(dayCell.dateKey)}
                    onFocus={() => setSelectedDateKey(dayCell.dateKey)}
                    tabIndex={selectedDay?.dateKey === dayCell.dateKey ? 0 : -1}
                    type="button"
                  >
                    <span
                      className={cn(
                        'flex aspect-square w-6 max-w-full items-center justify-center rounded-full text-[10px] tabular-nums transition-colors duration-300',
                        dayCell.isCurrentMonth ? 'opacity-100' : 'opacity-30',
                        backgroundClass,
                        selectedDay?.dateKey === dayCell.dateKey && 'outline outline-1 outline-offset-2 outline-accent dark:outline-peach',
                        hasActivity && dayCell.seconds >= 15 * 60 ? 'font-semibold text-white dark:text-stone-950' : 'text-stone-500 dark:text-stone-400',
                      )}
                    >
                      {dayCell.day}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 min-h-5 text-xs text-stone-500 dark:text-stone-400" role="status" aria-live="polite">
              {selectedDay && `${formatDateKeyLabel(selectedDay.dateKey)} · 阅读 ${formatReadingDuration(selectedDay.seconds)}`}
            </p>
          </div>
        </div>
      )}
      </>}
      </div>
    </Panel>
  );
}

function navigateChoices(event: KeyboardEvent<HTMLDivElement>, selector: string): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(selector));
  const index = choices.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  const vertical = selector === '[role=radio]';
  const next = event.key === 'ArrowRight' || vertical && event.key === 'ArrowDown' ? (index + 1) % choices.length
    : event.key === 'ArrowLeft' || vertical && event.key === 'ArrowUp' ? (index + choices.length - 1) % choices.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : -1;
  if (next < 0) return;
  event.preventDefault();
  choices[next].focus();
  choices[next].click();
}

function navigateCalendarDays(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const days = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.reading-calendar-day'));
  const index = days.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1
    : event.key === 'ArrowDown' ? index + 7 : event.key === 'ArrowUp' ? index - 7
      : event.key === 'Home' ? Math.floor(index / 7) * 7 : event.key === 'End' ? Math.floor(index / 7) * 7 + 6 : null;
  if (next === null) return;
  event.preventDefault();
  days[Math.max(0, Math.min(days.length - 1, next))]?.focus();
}

function ReadingPortraitSection({ goalHours, onGoalChange, portrait }: { goalHours: number; onGoalChange: (hours: number) => void; portrait: ReadingPortrait }) {
  const goalSeconds = goalHours * 3600;
  const goalProgress = goalSeconds > 0 ? Math.min(100, Math.floor((portrait.weekSeconds / goalSeconds) * 100)) : 0;
  const weekChange = formatWeekChange(portrait);
  const WeekTrendIcon = portrait.weekChangePercent !== null && portrait.weekChangePercent < 0 ? TrendingDown : TrendingUp;

  return (
    <section className={cn('mt-8 border-y py-6', HAIRLINE)} aria-labelledby="reading-portrait-title">
      <div className="grid gap-7 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)] lg:gap-12">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-accent dark:text-peach">
            <Sparkles className="h-4 w-4" />
            <span className={LABEL}>最近的阅读节奏</span>
          </div>
          <h3 className="mt-3 font-display text-3xl font-semibold lg:text-xl tracking-normal text-stone-950 dark:text-night-ink" id="reading-portrait-title">
            {portrait.rhythmLabel}
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-stone-600 dark:text-night-soft">{portrait.rhythmDescription}</p>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-stone-800 dark:text-night-copy">
              <Target className="h-4 w-4 text-accent dark:text-peach" />
              本周目标
            </div>
            <span className="text-xs tabular-nums text-stone-500 dark:text-stone-400">
              {formatReadingDuration(portrait.weekSeconds)} / {goalHours} 小时
            </span>
          </div>
          <p aria-label="本周统计范围" className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            {formatDateKeyLabel(portrait.weekStartDateKey)}–{formatDateKeyLabel(portrait.weekEndDateKey)} · 周一开始
          </p>
          <div className="mt-3 grid grid-cols-3 overflow-hidden rounded-lg border border-stone-200 sm:grid-cols-6 dark:border-white/10" aria-label="每周阅读目标" role="radiogroup" onKeyDown={(event) => navigateChoices(event, '[role=radio]')}>
            {WEEKLY_GOAL_OPTIONS.map((hours) => (
              <button
                aria-checked={goalHours === hours}
                aria-label={`每周阅读 ${hours} 小时`}
                role="radio"
                tabIndex={goalHours === hours ? 0 : -1}
                className={cn(
                  'min-h-11 min-w-0 border-b border-r border-stone-200 text-xs tabular-nums transition last:border-r-0 [&:nth-child(3)]:border-r-0 [&:nth-child(n+4)]:border-b-0 sm:border-b-0 sm:[&:nth-child(3)]:border-r focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent dark:border-white/10 dark:focus-visible:ring-peach',
                  goalHours === hours
                    ? 'bg-pink-50 font-semibold text-accent dark:bg-white/[0.09] dark:text-peach'
                    : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-white/[0.05] dark:hover:text-night-ink',
                )}
                key={hours}
                onClick={() => onGoalChange(hours)}
                type="button"
              >
                {hours}h
              </button>
            ))}
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-stone-200/80 dark:bg-white/10" aria-label="本周阅读目标进度" aria-valuemax={100} aria-valuemin={0} aria-valuenow={goalProgress} role="progressbar">
            <div className="h-full rounded-full bg-pink-500 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${goalProgress}%` }} />
          </div>
          <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
            {goalProgress >= 100
              ? portrait.weekSeconds > goalSeconds ? `已经完成目标，多读了 ${formatReadingDuration(portrait.weekSeconds - goalSeconds)}` : '已经完成本周目标'
              : `还差 ${formatReadingDuration(Math.max(0, goalSeconds - portrait.weekSeconds))}`}
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-y-5 sm:grid-cols-3">
        <PortraitInsight
          icon={<WeekTrendIcon className="h-4 w-4" />}
          label="相比上周同期"
          supporting={portrait.previousWeekToDateSeconds > 0 ? `上周同期 ${formatReadingDuration(portrait.previousWeekToDateSeconds)}` : '上周同期暂无记录'}
          value={weekChange}
        />
        <PortraitInsight
          icon={<BookMarked className="h-4 w-4" />}
          label="最投入的一册"
          supporting={portrait.focusBook ? `${portrait.focusSharePercent}% 的累计阅读时间` : '开始阅读后自动记录'}
          value={portrait.focusBook?.title ?? '等待相遇'}
        />
        <PortraitInsight
          icon={<Target className="h-4 w-4" />}
          label="下一个累计里程碑"
          supporting={`还差 ${formatReadingDuration(portrait.remainingMilestoneSeconds)}`}
          value={`${portrait.nextMilestoneHours} 小时`}
        />
      </div>
    </section>
  );
}

function PortraitInsight({ icon, label, supporting, value }: { icon: ReactNode; label: string; supporting: string; value: string }) {
  return (
    <div className="min-w-0 border-l border-accent/25 pl-4 sm:pl-5">
      <div className="flex items-center gap-2 text-stone-400 dark:text-stone-500">
        {icon}
        <span className={LABEL}>{label}</span>
      </div>
      <p className="mt-2 truncate font-display text-xl font-semibold tracking-normal text-stone-900 dark:text-night-ink" title={value}>{value}</p>
      <p className="mt-1 break-words text-xs leading-relaxed text-stone-500 dark:text-stone-400">{supporting}</p>
    </div>
  );
}

function formatWeekChange(portrait: ReadingPortrait): string {
  if (portrait.weekSeconds <= 0 && portrait.previousWeekToDateSeconds <= 0) return '等待记录';
  if (portrait.weekChangePercent === null) return '本周新开始';
  if (portrait.weekChangePercent === 0) return '与上周持平';
  return portrait.weekChangePercent > 0 ? `增加 ${portrait.weekChangePercent}%` : `减少 ${Math.abs(portrait.weekChangePercent)}%`;
}

function OverviewField({ label, value }: { label: string; value: string }) {
  return (
    <div className={cn('border-b pb-2.5', HAIRLINE)}>
      <dt className={LABEL}>{label}</dt>
      <dd className="mt-1.5 font-display text-lg font-medium tabular-nums text-stone-900 dark:text-night-ink">{value}</dd>
    </div>
  );
}

function getCalendarDays(activityStore: Record<string, number>, today: Date) {
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();

  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startingDayOfWeek = firstDay.getDay();

  const daysList: Array<{ dateKey: string; day: number; isCurrentMonth: boolean; seconds: number }> = [];

  for (let offset = startingDayOfWeek - 1; offset >= 0; offset -= 1) {
    const date = new Date(currentYear, currentMonth, -offset);
    const dateKey = formatDateKey(date);
    daysList.push({ dateKey, day: date.getDate(), isCurrentMonth: false, seconds: activityStore[dateKey] ?? 0 });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = formatDateKey(new Date(currentYear, currentMonth, day));
    daysList.push({ dateKey, day, isCurrentMonth: true, seconds: activityStore[dateKey] ?? 0 });
  }

  const totalCells = Math.ceil(daysList.length / 7) * 7;
  for (let day = 1; daysList.length < totalCells; day += 1) {
    const date = new Date(currentYear, currentMonth + 1, day);
    const dateKey = formatDateKey(date);
    daysList.push({ dateKey, day: date.getDate(), isCurrentMonth: false, seconds: activityStore[dateKey] ?? 0 });
  }

  return daysList;
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLongestReadingStreakDays(dateKeys: string[]): number {
  const sortedDates = Array.from(new Set(dateKeys))
    .map(parseDateKey)
    .filter((date): date is Date => date !== null)
    .sort((left, right) => left.getTime() - right.getTime());

  if (sortedDates.length === 0) return 0;

  let longestStreak = 1;
  let currentStreak = 1;

  for (let index = 1; index < sortedDates.length; index += 1) {
    const previous = sortedDates[index - 1];
    const current = sortedDates[index];
    const dayDiff = Math.round((current.getTime() - previous.getTime()) / 86_400_000);

    if (dayDiff === 1) {
      currentStreak += 1;
    } else if (dayDiff > 1) {
      currentStreak = 1;
    }

    longestStreak = Math.max(longestStreak, currentStreak);
  }

  return longestStreak;
}

function formatDateKeyLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-');
  return year && month && day ? `${Number(month)}月${Number(day)}日` : dateKey;
}

function parseDateKey(dateKey: string): Date | null {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}
