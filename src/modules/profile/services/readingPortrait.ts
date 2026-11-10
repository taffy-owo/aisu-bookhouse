import { summarizeReadingWeek } from '../../reading-progress/services/readingWeek';

export interface ReadingPortraitBookTotal {
  bookId: string;
  seconds: number;
  title: string;
}

export interface ReadingPortrait {
  activeDays28: number;
  focusBook: ReadingPortraitBookTotal | null;
  focusSharePercent: number;
  milestoneProgressPercent: number;
  nextMilestoneHours: number;
  previousWeekSeconds: number;
  previousWeekToDateSeconds: number;
  remainingMilestoneSeconds: number;
  rhythmDescription: string;
  rhythmLabel: string;
  weekChangePercent: number | null;
  weekSeconds: number;
  weekStartDateKey: string;
  weekEndDateKey: string;
}

export function buildReadingPortrait(
  activityStore: Record<string, number>,
  bookTotals: ReadingPortraitBookTotal[],
  now = new Date(),
): ReadingPortrait {
  const week = summarizeReadingWeek(activityStore, now);
  const activeDays28 = countActiveDays(activityStore, now, 28);
  const totalSeconds = sumPositiveSeconds(Object.values(activityStore));
  const normalizedBookTotals = bookTotals
    .filter((book) => book.seconds > 0)
    .sort((left, right) => right.seconds - left.seconds);
  const focusBook = normalizedBookTotals[0] ?? null;
  const attributedSeconds = sumPositiveSeconds(normalizedBookTotals.map((book) => book.seconds));
  const focusSharePercent = focusBook && attributedSeconds > 0
    ? Math.round((focusBook.seconds / attributedSeconds) * 100)
    : 0;
  const averageActiveDaySeconds = activeDays28 > 0
    ? getRollingPeriodSeconds(activityStore, now, 0, 28) / activeDays28
    : 0;
  const rhythm = describeRhythm({
    activeDays28,
    averageActiveDaySeconds,
    bookCount: normalizedBookTotals.length,
    focusBook,
    focusSharePercent,
    totalSeconds,
  });
  const milestone = getNextReadingMilestone(totalSeconds);

  return {
    activeDays28,
    focusBook,
    focusSharePercent,
    milestoneProgressPercent: milestone.progressPercent,
    nextMilestoneHours: milestone.targetHours,
    previousWeekSeconds: week.previousSeconds,
    previousWeekToDateSeconds: week.previousToDateSeconds,
    remainingMilestoneSeconds: milestone.remainingSeconds,
    rhythmDescription: rhythm.description,
    rhythmLabel: rhythm.label,
    weekChangePercent: getWeekChangePercent(week.seconds, week.previousToDateSeconds),
    weekSeconds: week.seconds,
    weekStartDateKey: week.startDateKey,
    weekEndDateKey: week.endDateKey,
  };
}

function describeRhythm({
  activeDays28,
  averageActiveDaySeconds,
  bookCount,
  focusBook,
  focusSharePercent,
  totalSeconds,
}: {
  activeDays28: number;
  averageActiveDaySeconds: number;
  bookCount: number;
  focusBook: ReadingPortraitBookTotal | null;
  focusSharePercent: number;
  totalSeconds: number;
}): { description: string; label: string } {
  if (totalSeconds <= 0) {
    return { description: '开始阅读后，这里会慢慢长成只属于你的阅读记录。', label: '等待开篇' };
  }
  if (activeDays28 >= 18) {
    return {
      description: `过去 28 天有 ${activeDays28} 天留下了阅读记录，阅读已经成为稳定的日常。`,
      label: '稳定相伴',
    };
  }
  if (focusBook && focusSharePercent >= 65 && focusBook.seconds >= 2 * 3600) {
    return {
      description: `你把 ${focusSharePercent}% 的阅读时间留给了《${focusBook.title}》，最近更偏向沉浸在一本书里。`,
      label: '专注一册',
    };
  }
  if (bookCount >= 5 && focusSharePercent < 45) {
    return {
      description: `你的阅读时间分布在 ${bookCount} 本书之间，最近喜欢沿着不同故事同时前进。`,
      label: '多线探索',
    };
  }
  if (averageActiveDaySeconds >= 90 * 60) {
    return {
      description: `有阅读记录的日子里，你平均会读 ${Math.round(averageActiveDaySeconds / 60)} 分钟，更喜欢一次读得深入。`,
      label: '长读沉浸',
    };
  }
  return {
    description: `过去 28 天有 ${activeDays28} 天翻开书页，没有固定节拍，也是一种自在的阅读方式。`,
    label: '随心翻页',
  };
}

function getNextReadingMilestone(totalSeconds: number): { progressPercent: number; remainingSeconds: number; targetHours: number } {
  const totalHours = Math.max(0, totalSeconds / 3600);
  const milestones = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
  const targetHours = milestones.find((hours) => hours > totalHours) ?? (Math.floor(totalHours / 500) + 1) * 500;
  const previousHours = [...milestones].reverse().find((hours) => hours <= totalHours) ?? 0;
  const intervalHours = Math.max(1, targetHours - previousHours);
  const progressPercent = Math.round(((totalHours - previousHours) / intervalHours) * 100);
  return {
    progressPercent: Math.max(0, Math.min(100, progressPercent)),
    remainingSeconds: Math.max(0, Math.round((targetHours - totalHours) * 3600)),
    targetHours,
  };
}

function getWeekChangePercent(currentSeconds: number, previousSeconds: number): number | null {
  if (previousSeconds <= 0) return currentSeconds > 0 ? null : 0;
  return Math.round(((currentSeconds - previousSeconds) / previousSeconds) * 100);
}

function countActiveDays(store: Record<string, number>, now: Date, dayCount: number): number {
  let count = 0;
  for (let offset = 0; offset < dayCount; offset += 1) {
    if ((store[formatLocalDateKey(addLocalDays(now, -offset))] ?? 0) > 0) count += 1;
  }
  return count;
}

function getRollingPeriodSeconds(store: Record<string, number>, now: Date, startOffset: number, dayCount: number): number {
  let total = 0;
  for (let offset = startOffset; offset < startOffset + dayCount; offset += 1) {
    total += Math.max(0, Math.round(store[formatLocalDateKey(addLocalDays(now, -offset))] ?? 0));
  }
  return total;
}

function sumPositiveSeconds(values: number[]): number {
  return values.reduce((total, value) => total + Math.max(0, Math.round(value || 0)), 0);
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
