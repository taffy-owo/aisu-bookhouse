import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, getAccountScope, setStoredSession } from '../../../shared/api';
import { fetchCloudReadingActivitySummary, queueReadingActivitySync, syncReadingActivity, type CloudReadingActivitySummary } from './readingActivity';
import { readCloudReadingActivityCache, saveCloudReadingActivityCache } from './readingActivityCache';

let account = 0;
beforeEach(() => {
  vi.stubEnv('VITE_USE_BACKEND_API', 'true');
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  setStoredSession({ id: 'activity-snapshot-' + ++account, nickname: 'A', role: 'user' });
  saveCloudReadingActivityCache(summary(600));
});
afterEach(() => { clearAuthStorage(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('reading activity snapshot ownership', () => {
  it('accepts a read containing more confirmed activity than an intervening write', async () => {
    let finishRead!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishRead = resolve; }))
      .mockResolvedValueOnce(Response.json(summary(630))));
    const read = fetchCloudReadingActivitySummary();
    await queueReadingActivitySync(30, new Date(2026, 9, 26), 'snapshot-book');
    finishRead(Response.json(summary(690)));
    expect((await read)?.total_seconds).toBe(690);
    expect(readCloudReadingActivityCache()?.total_seconds).toBe(690);
  });

  it('keeps the newer acknowledged total when independent writes return out of order', async () => {
    const finish: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish.push(resolve); })));
    const older = syncReadingActivity(30, new Date(2026, 9, 26), 'snapshot-book');
    const latest = syncReadingActivity(60, new Date(2026, 9, 26), 'snapshot-book');
    finish[1](Response.json(summary(690)));
    expect((await latest)?.total_seconds).toBe(690);
    finish[0](Response.json(summary(630)));
    expect((await older)?.total_seconds).toBe(690);
    expect(readCloudReadingActivityCache()?.total_seconds).toBe(690);
  });

  it('acknowledges a delayed queued event without replacing a newer peer summary', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const older = queueReadingActivitySync(30, new Date(2026, 9, 26), 'snapshot-book');
    saveCloudReadingActivityCache(summary(690));
    finish(Response.json(summary(630)));
    await older;
    expect(readCloudReadingActivityCache()?.total_seconds).toBe(690);
  });

  it('does not let a slow read undo a newer acknowledged activity event', async () => {
    let finishRead!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = resolve; }))
      .mockResolvedValueOnce(Response.json(summary(630))));
    const olderRead = fetchCloudReadingActivitySummary();
    await queueReadingActivitySync(30, new Date(2026, 9, 26), 'snapshot-book');
    expect(readCloudReadingActivityCache()?.total_seconds).toBe(630);
    finishRead(Response.json(summary(600)));
    expect((await olderRead)?.total_seconds).toBe(630);
    expect(readCloudReadingActivityCache()?.total_seconds).toBe(630);
  });

  it('keeps the later requested snapshot when two cloud reads finish in reverse order', async () => {
    const finish: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish.push(resolve); })));
    const first = fetchCloudReadingActivitySummary();
    const latest = fetchCloudReadingActivitySummary();
    finish[1](Response.json(summary(900)));
    expect((await latest)?.total_seconds).toBe(900);
    finish[0](Response.json(summary(600)));
    expect((await first)?.total_seconds).toBe(900);
    expect(readCloudReadingActivityCache()?.total_seconds).toBe(900);
  });

  it('preserves a snapshot updated by another tab while its read is pending', async () => {
    let finishRead!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finishRead = resolve; })));
    const pending = fetchCloudReadingActivitySummary();
    const scope = getAccountScope();
    const id = JSON.parse(scope) as string;
    window.localStorage.setItem('aisu-bookhouse:cloud-reading-activity:' + id, JSON.stringify({
      version: 1, accountScope: scope, savedAt: Date.now() + 1, summary: summary(900),
    }));
    finishRead(Response.json(summary(600)));
    expect((await pending)?.total_seconds).toBe(900);
    expect(readCloudReadingActivityCache()?.total_seconds).toBe(900);
  });

  it('never publishes an aborted read to the shared cache', async () => {
    let finishRead!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finishRead = resolve; })));
    const controller = new AbortController();
    const pending = fetchCloudReadingActivitySummary(controller.signal);
    controller.abort();
    finishRead(Response.json(summary(900)));
    await pending;
    expect(readCloudReadingActivityCache()?.total_seconds).toBe(600);
  });
});

function summary(seconds: number): CloudReadingActivitySummary {
  return {
    active_days: 1, book_totals: [{ book_id: 'snapshot-book', book_title: '测试书', seconds }],
    days: [{ date_key: '2026-10-26', seconds }], first_read_date: '2026-10-26', last_read_date: '2026-10-26',
    longest_streak_days: 1, streak_days: 1, today_seconds: seconds, total_seconds: seconds, week_seconds: seconds,
  };
}
