import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReadingPortrait } from './readingPortrait';

const now = new Date(2026, 7, 1, 12);
afterEach(() => vi.unstubAllEnvs());

describe('buildReadingPortrait', () => {
  it('returns a welcoming empty state without inventing a personality', () => {
    const portrait = buildReadingPortrait({}, [], now);

    expect(portrait.rhythmLabel).toBe('等待开篇');
    expect(portrait.weekSeconds).toBe(0);
    expect(portrait.nextMilestoneHours).toBe(1);
  });

  it('recognizes focused reading from attributed book time', () => {
    const portrait = buildReadingPortrait(
      { '2026-08-01': 7200, '2026-07-31': 3600 },
      [
        { bookId: 'focus', seconds: 9000, title: '专注的书' },
        { bookId: 'other', seconds: 1800, title: '另一册' },
      ],
      now,
    );

    expect(portrait.rhythmLabel).toBe('专注一册');
    expect(portrait.focusSharePercent).toBe(83);
    expect(portrait.rhythmDescription).toContain('《专注的书》');
  });

  it('recognizes broad exploration when time is spread across books', () => {
    const books = Array.from({ length: 6 }, (_, index) => ({
      bookId: `book-${index}`,
      seconds: 3600,
      title: `第 ${index + 1} 本`,
    }));
    const portrait = buildReadingPortrait({ '2026-08-01': 6 * 3600 }, books, now);

    expect(portrait.rhythmLabel).toBe('多线探索');
    expect(portrait.focusSharePercent).toBe(17);
  });

  it('compares the current calendar week with the same days of the preceding week', () => {
    const portrait = buildReadingPortrait(
      {
        '2026-08-01': 3600,
        '2026-07-31': 3600,
        '2026-07-25': 1800,
        '2026-07-24': 1800,
        '2026-07-20': 1200,
        '2026-07-26': 45000,
      },
      [],
      now,
    );

    expect(portrait.weekSeconds).toBe(7200);
    expect(portrait.previousWeekSeconds).toBe(49800);
    expect(portrait.weekChangePercent).toBe(50);
  });

  it('resets the weekly goal on Monday and compares only the matching previous Monday', () => {
    const portrait = buildReadingPortrait({ '2026-11-09': 60, '2026-11-15': 7200 }, [], new Date(2026, 10, 16, 12));
    expect(portrait.weekSeconds).toBe(0);
    expect(portrait.previousWeekSeconds).toBe(7260);
    expect(portrait.weekChangePercent).toBe(-100);
  });

  it('excludes later weekdays from the comparison but retains the full previous week for goal recommendations', () => {
    const portrait = buildReadingPortrait({
      '2026-11-09': 3600, '2026-11-10': 1800, '2026-11-11': 900, '2026-11-12': 7200,
      '2026-11-16': 1800, '2026-11-17': 900, '2026-11-18': 450, '2026-11-19': 999,
    }, [], new Date(2026, 10, 18, 12));
    expect(portrait).toMatchObject({
      weekStartDateKey: '2026-11-16', weekEndDateKey: '2026-11-22', weekSeconds: 3150,
      previousWeekSeconds: 13500, previousWeekToDateSeconds: 6300, weekChangePercent: -50,
    });
  });

  it.each([
    { month: 2, day: 8, start: '2026-03-02', end: '2026-03-08', tomorrow: '2026-03-09' },
    { month: 10, day: 1, start: '2026-10-26', end: '2026-11-01', tomorrow: '2026-11-02' },
  ])('keeps the entire local week across daylight-saving Sunday $end', ({ month, day, start, end, tomorrow }) => {
    vi.stubEnv('TZ', 'America/New_York');
    const portrait = buildReadingPortrait({ [start]: 120, [end]: 60, [tomorrow]: 600 }, [], new Date(2026, month, day, 12));
    expect(portrait).toMatchObject({ weekStartDateKey: start, weekEndDateKey: end, weekSeconds: 180 });
  });

  it('tracks progress inside the next meaningful lifetime milestone', () => {
    const portrait = buildReadingPortrait({ '2026-08-01': 30 * 3600 }, [], now);

    expect(portrait.nextMilestoneHours).toBe(50);
    expect(portrait.remainingMilestoneSeconds).toBe(20 * 3600);
    expect(portrait.milestoneProgressPercent).toBe(20);
  });
});
