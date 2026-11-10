import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearAuthStorage, setStoredSession } from '../../../shared/api';
import { ReadingAnalyticsPanel } from './ReadingAnalyticsPanel';
import { saveCloudReadingActivityCache } from '../../reading-progress/services/readingActivityCache';

let sequence = 0, id: string, values: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 2, 12));
  values = new Map(); id = 'short-reading-' + ++sequence;
  vi.stubGlobal('window', { localStorage: {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  setStoredSession({ id, nickname: 'A', role: 'user' });
  saveCloudReadingActivityCache({ days: [], book_totals: [], today_seconds: 0, week_seconds: 0, total_seconds: 0,
    streak_days: 0, active_days: 0, first_read_date: null, last_read_date: null, longest_streak_days: 0 });
});
afterEach(() => { clearAuthStorage(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function panel(days: Record<string, number>): string {
  values.set('aisu-bookhouse:reading-activity:' + id, JSON.stringify(days));
  return renderToStaticMarkup(<ReadingAnalyticsPanel accountId={id} books={[]} />);
}
function field(markup: string, label: string): string | undefined {
  return markup.match(new RegExp('<dt[^>]*>' + label + '</dt><dd[^>]*>(.*?)</dd>'))?.[1];
}

describe('reading analytics preserve positive seconds', () => {
  it('counts every short reading day and preserves the latest day across a month boundary', () => {
    const markup = panel({ '2026-10-31': 59, '2026-11-01': 25, '2026-11-02': 1 });
    expect(field(markup, '记录天数')).toBe('3 天');
    expect(field(markup, '最长连续')).toBe('3 天');
    expect(field(markup, '开始记录')).toBe('10月31日');
    expect(field(markup, '最近记录')).toBe('11月2日');
    expect(field(markup, '活跃日均')).toBe('不到 1 分钟');
    expect(field(markup, '最佳单日')).toBe('不到 1 分钟 · 10月31日');
  });
  it('picks the actual longest day when displayed whole minutes tie', () => {
    const markup = panel({ '2026-11-01': 60, '2026-11-02': 89 });
    expect(field(markup, '最佳单日')).toBe('1 分钟 · 11月2日');
  });
  it('keeps consecutive sub-minute readings across a year boundary', () => {
    const markup = panel({ '2025-12-31': 1, '2026-01-01': 1 });
    expect(field(markup, '记录天数')).toBe('2 天');
    expect(field(markup, '最长连续')).toBe('2 天');
  });
  it('does not turn a zero reading day into recorded activity', () => {
    const markup = panel({ '2026-11-02': 0 });
    expect(field(markup, '记录天数')).toBe('0 天');
    expect(field(markup, '活跃日均')).toBe('0 分钟');
    expect(field(markup, '最佳单日')).toBe('暂无');
  });
});
