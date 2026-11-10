import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecommendedWeeklyGoal, getWeeklyGoalStorageKey, hasStoredWeeklyGoal, readWeeklyGoal, writeWeeklyGoal } from './weeklyReadingGoal';

let sequence = 0;
let id: string;
let values: Map<string, string>;
beforeEach(() => {
  id = 'weekly-goal-' + ++sequence;
  values = new Map();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('weekly reading goal preferences', () => {
  it('distinguishes a default or recommended target from a chosen target', () => {
    expect(readWeeklyGoal(id)).toBe(5);
    expect(hasStoredWeeklyGoal(id)).toBe(false);
    writeWeeklyGoal(id, 20);
    expect(readWeeklyGoal(id)).toBe(20);
    expect(hasStoredWeeklyGoal(id)).toBe(true);
    expect(values.get(getWeeklyGoalStorageKey(id))).toBe('20');
  });

  it.each(['invalid', '-1', '0', '500'])('ignores invalid persisted target %s instead of treating it as an explicit choice', (raw) => {
    values.set(getWeeklyGoalStorageKey(id), raw);
    expect(readWeeklyGoal(id)).toBe(5);
    expect(hasStoredWeeklyGoal(id)).toBe(false);
  });

  it('retains explicit choices independently for each account when storage is blocked', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Blocked'); } });
    writeWeeklyGoal(id, 20);
    expect(hasStoredWeeklyGoal(id)).toBe(true);
    expect(readWeeklyGoal(id)).toBe(20);
    expect(readWeeklyGoal(id + '-other')).toBe(5);
    writeWeeklyGoal(id + '-other', 10);
    expect(readWeeklyGoal(id)).toBe(20);
    expect(readWeeklyGoal(id + '-other')).toBe(10);
  });

  it('keeps a newer choice while an older readable target remains after a quota error', () => {
    writeWeeklyGoal(id, 5);
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
    writeWeeklyGoal(id, 20);
    expect(values.get(getWeeklyGoalStorageKey(id))).toBe('5');
    expect(hasStoredWeeklyGoal(id)).toBe(true);
    expect(readWeeklyGoal(id)).toBe(20);
    window.localStorage.setItem = original;
    expect(readWeeklyGoal(id)).toBe(20);
    expect(values.get(getWeeklyGoalStorageKey(id))).toBe('20');
  });

  it('accepts another tab update or removal when there is no unsaved local choice', () => {
    writeWeeklyGoal(id, 20);
    values.set(getWeeklyGoalStorageKey(id), '10');
    expect(readWeeklyGoal(id)).toBe(10);
    values.delete(getWeeklyGoalStorageKey(id));
    expect(readWeeklyGoal(id)).toBe(5);
    expect(hasStoredWeeklyGoal(id)).toBe(false);
  });

  it('recommends a supported target at or above the reference time', () => {
    expect([-1, 0, 1, 4 * 3600, 5 * 3600 + 1, 70 * 3600].map(getRecommendedWeeklyGoal)).toEqual([5, 5, 2, 5, 10, 60]);
  });
});
