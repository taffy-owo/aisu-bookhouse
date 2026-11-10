export const WEEKLY_GOAL_OPTIONS = [2, 5, 10, 20, 40, 60] as const;
const DEFAULT_WEEKLY_GOAL_HOURS = 5;
const memoryGoals = new Map<string, number>();
const memoryOnlyGoals = new Set<string>();

export function getWeeklyGoalStorageKey(accountId?: string): string {
  return `aisu-weekly-reading-goal:${accountId || 'local'}`;
}

function readChosenGoal(accountId?: string): number | null {
  const key = getWeeklyGoalStorageKey(accountId);
  try {
    if (typeof window === 'undefined') return memoryGoals.get(key) ?? null;
    const storage = window.localStorage;
    const raw = storage.getItem(key);
    if (memoryOnlyGoals.has(key)) {
      const chosen = memoryGoals.get(key) ?? null;
      if (chosen !== null) {
        try {
          storage.setItem(key, String(chosen));
          memoryOnlyGoals.delete(key);
        } catch { /* Keep the explicit choice during storage denial. */ }
      }
      return chosen;
    }
    const value = Number(raw);
    if (raw !== null && WEEKLY_GOAL_OPTIONS.includes(value as (typeof WEEKLY_GOAL_OPTIONS)[number])) {
      memoryGoals.set(key, value);
      return value;
    }
    memoryGoals.delete(key);
    return null;
  } catch {
    return memoryGoals.get(key) ?? null;
  }
}

export function readWeeklyGoal(accountId?: string): number {
  return readChosenGoal(accountId) ?? DEFAULT_WEEKLY_GOAL_HOURS;
}

export function hasStoredWeeklyGoal(accountId?: string): boolean {
  return readChosenGoal(accountId) !== null;
}

export function getRecommendedWeeklyGoal(referenceSeconds: number): number {
  if (referenceSeconds <= 0) return DEFAULT_WEEKLY_GOAL_HOURS;
  return WEEKLY_GOAL_OPTIONS.find((hours) => hours >= referenceSeconds / 3600) ?? WEEKLY_GOAL_OPTIONS.at(-1) ?? DEFAULT_WEEKLY_GOAL_HOURS;
}

export function writeWeeklyGoal(accountId: string | undefined, hours: number): void {
  if (!WEEKLY_GOAL_OPTIONS.includes(hours as (typeof WEEKLY_GOAL_OPTIONS)[number])) return;
  const key = getWeeklyGoalStorageKey(accountId);
  memoryGoals.set(key, hours);
  try {
    if (typeof window === 'undefined') throw new Error('Storage unavailable');
    window.localStorage.setItem(key, String(hours));
    memoryOnlyGoals.delete(key);
  } catch {
    memoryOnlyGoals.add(key);
  }
}
