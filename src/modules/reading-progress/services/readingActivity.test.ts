import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, setStoredSession } from '../../../shared/api/authTokenStore';
import {
  flushReadingActivityOutbox,
  fetchCloudReadingActivitySummary,
  formatReadingDuration,
  getReadingActivitySummary,
  readReadingActivityStore,
  summarizeReadingActivityStore,
  recordReadingActivity,
  queueReadingActivitySync,
  writeReadingActivityStore,
} from './readingActivity';

describe('readingActivity', () => {
  it('passes cancellation signals to cloud activity reads', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        active_days: 0,
        book_totals: [],
        days: [],
        first_read_date: null,
        last_read_date: null,
        longest_streak_days: 0,
        streak_days: 0,
        today_seconds: 0,
        total_seconds: 0,
        week_seconds: 0,
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCloudReadingActivitySummary(controller.signal)).resolves.toMatchObject({ total_seconds: 0 });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/reading-activity', expect.objectContaining({ signal: controller.signal }));
  });

  it('preserves daily seconds when a shared book becomes unavailable', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Book not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    await queueReadingActivitySync(30, new Date(), 'revoked-book');
    await queueReadingActivitySync(20, new Date(), 'available-book');
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)));
    expect(payloads[1]).toMatchObject({ ...payloads[0], book_id: null });
    expect(payloads[2]).toMatchObject({ book_id: 'available-book', seconds: 20 });
    expect(store.get('aisu-bookhouse:reading-activity-outbox:a')).toBeUndefined();
  });

  it('keeps each account outbox independent while an earlier request is pending', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    } });
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setStoredSession({ id: 'a', nickname: 'A', role: 'user' });
    const oldResult = expect(queueReadingActivitySync(30, new Date(), 'book-a'))
      .rejects.toMatchObject({ name: 'AbortError' });
    setStoredSession({ id: 'b', nickname: 'B', role: 'user' });
    await queueReadingActivitySync(20, new Date(), 'book-b');
    finish(new Response('{}', { status: 200 }));
    await oldResult;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...store.entries()].filter(([key]) => key.startsWith('aisu-bookhouse:reading-activity-outbox-v2:')).map(([, value]) => JSON.parse(value).event.bookId)).toContain('book-a');
    expect(store.get('aisu-bookhouse:reading-activity-outbox:b')).toBeUndefined();
  });

  afterEach(() => {
    writeReadingActivityStore({});
    clearAuthStorage();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('records reading seconds by local day and summarizes today and week totals', () => {
    const today = new Date(2026, 4, 21, 20, 30, 0);

    recordReadingActivity(90, today);
    recordReadingActivity(30, today);

    expect(getReadingActivitySummary(today)).toMatchObject({
      lastReadDate: '2026-05-21',
      streakDays: 1,
      todaySeconds: 120,
      totalSeconds: 120,
      weekSeconds: 120,
    });
  });

  it('counts a continuous streak from today or the latest previous reading day', () => {
    const today = new Date(2026, 4, 21, 8, 0, 0);

    writeReadingActivityStore({
      '2026-05-18': 20,
      '2026-05-19': 60,
      '2026-05-20': 120,
    });

    expect(getReadingActivitySummary(today).streakDays).toBe(3);

    recordReadingActivity(60, today);

    expect(getReadingActivitySummary(today).streakDays).toBe(4);
  });

  it('formats readable duration labels', () => {
    expect(formatReadingDuration(0)).toBe('0 分钟');
    expect(formatReadingDuration(12)).toBe('不到 1 分钟');
    expect(formatReadingDuration(1500)).toBe('25 分钟');
    expect(formatReadingDuration(7_500)).toBe('2 小时 5 分钟');
  });

  it('starts this week on local Monday without carrying Sunday reading forward', () => {
    const store = { '2026-11-15': 7200, '2026-11-16': 60, '2026-11-17': 600 };
    expect(summarizeReadingActivityStore(store, new Date(2026, 10, 16, 12))).toMatchObject({
      todaySeconds: 60, weekSeconds: 60, totalSeconds: 7860,
    });
  });

  it('keeps Sunday in its existing week across a year boundary', () => {
    const store = { '2025-12-28': 600, '2025-12-29': 120, '2026-01-01': 180, '2026-01-04': 60 };
    expect(summarizeReadingActivityStore(store, new Date(2026, 0, 4, 23, 59)).weekSeconds).toBe(360);
    expect(summarizeReadingActivityStore(store, new Date(2026, 0, 5)).weekSeconds).toBe(0);
  });

  it('keeps activity in memory when browser storage is blocked', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('storage blocked');
      },
    });

    expect(() => writeReadingActivityStore({ '2026-05-21': 180 })).not.toThrow();
    expect(readReadingActivityStore()).toEqual({ '2026-05-21': 180 });
  });

  it('scopes activity storage by the current user', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });

    setStoredSession({ id: 'user-a', nickname: 'A', role: 'user', status: 'active' });
    writeReadingActivityStore({ '2026-05-21': 180 });

    setStoredSession({ id: 'user-b', nickname: 'B', role: 'user', status: 'active' });
    expect(readReadingActivityStore()).toEqual({});
    writeReadingActivityStore({ '2026-05-22': 60 });

    setStoredSession({ id: 'user-a', nickname: 'A', role: 'user', status: 'active' });
    expect(readReadingActivityStore()).toEqual({ '2026-05-21': 180 });
  });

  it('keeps a failed cloud event in the outbox and retries it once', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    vi.stubGlobal('crypto', { randomUUID: () => 'activity-event-0001' });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ days: [], book_totals: [] }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }));
    vi.stubGlobal('fetch', fetchMock);
    setStoredSession({ id: 'user-a', nickname: 'A', role: 'user', status: 'active' });

    await expect(queueReadingActivitySync(30, new Date(2026, 6, 10, 23, 30), 'book-1')).rejects.toThrow('offline');
    await flushReadingActivityOutbox();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      book_id: 'book-1',
      date_key: '2026-07-10',
      event_id: 'activity-event-0001',
      seconds: 30,
    });
    expect(store.get('aisu-bookhouse:reading-activity-outbox:user-a')).toBeUndefined();
  });
});
