import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, getAccountScope, setStoredSession } from '../../../shared/api';
import { flushReadingActivityOutbox, getBookReadingTime, getPendingReadingActivitySummary, getReadingActivitySummary, readBookReadingTimeStore, readReadingActivityStore, queueReadingActivitySync, recordReadingActivity } from './readingActivity';

afterEach(() => { clearAuthStorage(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('pending reading activity resilience', () => {
  it.each([false,true])('retains a former account tail without using the new credentials (blocked storage: %s)', async (blocked) => {
    vi.stubEnv('VITE_USE_BACKEND_API','true');const storage=mockActivityStorage();storage.block.all=blocked;
    setStoredSession({id:'tail-a-'+blocked,nickname:'A',role:'user'});const scope=getAccountScope();
    setStoredSession({id:'tail-b-'+blocked,nickname:'B',role:'user'});
    const fetchMock=vi.fn().mockImplementation(async()=>new Response('{}'));vi.stubGlobal('fetch',fetchMock);
    const date=new Date(2026,9,28,23,59,59);
    recordReadingActivity(7,date,'book',scope);await queueReadingActivitySync(7,date,'book',{accountScope:scope,keepalive:true});
    expect(fetchMock).not.toHaveBeenCalled();expect(getReadingActivitySummary(date).totalSeconds).toBe(0);
    expect(getPendingReadingActivitySummary().seconds).toBe(0);
    setStoredSession({id:'tail-a-'+blocked,nickname:'A',role:'user'});
    expect(getReadingActivitySummary(date).totalSeconds).toBe(7);expect(getBookReadingTime('book')).toBe(7);
    expect(getPendingReadingActivitySummary().seconds).toBe(7);await flushReadingActivityOutbox();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({seconds:7,date_key:'2026-10-28',book_id:'book'});
    expect(getPendingReadingActivitySummary().seconds).toBe(0);
  });
  it('a late old-account response cannot erase its queued tail or publish into the next account', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API','true');mockActivityStorage();
    setStoredSession({id:'late-tail-a',nickname:'A',role:'user'});const scope=getAccountScope();
    let finish!:(response:Response)=>void;
    const fetchMock=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve})).mockImplementation(async()=>new Response('{}'));
    vi.stubGlobal('fetch',fetchMock);const first=expect(queueReadingActivitySync(30)).rejects.toMatchObject({name:'AbortError'});
    setStoredSession({id:'late-tail-b',nickname:'B',role:'user'});await queueReadingActivitySync(7,new Date(),'book',{accountScope:scope});
    finish(new Response('{}'));await first;expect(fetchMock).toHaveBeenCalledOnce();expect(getPendingReadingActivitySummary().seconds).toBe(0);
    setStoredSession({id:'late-tail-a',nickname:'A',role:'user'});expect(getPendingReadingActivitySummary().seconds).toBe(37);await flushReadingActivityOutbox();
    const bodies=fetchMock.mock.calls.map(([,options])=>JSON.parse(String(options.body)));
    expect(bodies[1].event_id).toBe(bodies[0].event_id);expect(bodies[2].seconds).toBe(7);expect(getPendingReadingActivitySummary().seconds).toBe(0);
  });
  it('still uploads and retries the same event when all browser storage is blocked', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    vi.stubGlobal('window', { get localStorage() { throw new Error('blocked'); } });
    setStoredSession({ id: 'blocked-outbox', nickname: 'A', role: 'user' });
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(queueReadingActivitySync(30)).rejects.toThrow('offline');
    expect(getPendingReadingActivitySummary()).toEqual({ eventCount: 1, seconds: 30 });
    await flushReadingActivityOutbox();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(getPendingReadingActivitySummary()).toEqual({ eventCount: 0, seconds: 0 });
  });
  it('merges a failed local write with another tab’s saved event before retrying', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const store = new Map<string, string>();
    let quotaBlocked = true;
    const outboxKey = 'aisu-bookhouse:reading-activity-outbox:quota-outbox';
    store.set(outboxKey, '[]');
    vi.stubGlobal('window', { localStorage: { get length() { return store.size; }, key: (index: number) => [...store.keys()][index] ?? null, getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { if (key.startsWith('aisu-bookhouse:reading-activity-outbox') && quotaBlocked) throw new Error('quota'); store.set(key, value); }, removeItem: (key: string) => store.delete(key) } });
    setStoredSession({ id: 'quota-outbox', nickname: 'A', role: 'user' });
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(queueReadingActivitySync(30)).rejects.toThrow('offline');
    store.set(outboxKey, JSON.stringify([{ eventId: 'peer-event', dateKey: '2026-10-24', occurredAt: '2026-10-24T00:00:00Z', seconds: 15 }]));
    expect(getPendingReadingActivitySummary()).toEqual({ eventCount: 2, seconds: 45 });
    quotaBlocked = false;
    await flushReadingActivityOutbox();
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)));
    expect(bodies[1].event_id).toBe('peer-event');
    expect(bodies[2].event_id).toBe(bodies[0].event_id);
    expect(store.get(outboxKey)).toBeUndefined();
  });
  it('keeps memory-only pending events isolated during account switching', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    vi.stubGlobal('window', { get localStorage() { throw new Error('blocked'); } });
    setStoredSession({ id: 'memory-outbox-a', nickname: 'A', role: 'user' });
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(queueReadingActivitySync(30)).rejects.toThrow('offline');
    setStoredSession({ id: 'memory-outbox-b', nickname: 'B', role: 'user' });
    expect(getPendingReadingActivitySummary().eventCount).toBe(0);
    await queueReadingActivitySync(15);
    setStoredSession({ id: 'memory-outbox-a', nickname: 'A', role: 'user' });
    expect(getPendingReadingActivitySummary()).toEqual({ eventCount: 1, seconds: 30 });
    await flushReadingActivityOutbox();
    expect(getPendingReadingActivitySummary().eventCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not replay acknowledged events when their removal cannot be persisted', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const storage = mockActivityStorage();
    const key = 'aisu-bookhouse:reading-activity-outbox:ack-quota';
    storage.values.set(key, JSON.stringify([activityEvent('quota-event', 30)]));
    storage.block.write = true;
    setStoredSession({ id: 'ack-quota', nickname: 'A', role: 'user' });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{}')).mockRejectedValue(new Error('Unexpected duplicate replay'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(flushReadingActivityOutbox()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getPendingReadingActivitySummary()).toEqual({ eventCount: 0, seconds: 0 });
    expect(JSON.parse(storage.values.get(key)!)).toHaveLength(1);
    setStoredSession({ id: 'ack-quota-other', nickname: 'B', role: 'user' });
    expect(getPendingReadingActivitySummary().eventCount).toBe(0);
    setStoredSession({ id: 'ack-quota', nickname: 'A', role: 'user' });
    expect(getPendingReadingActivitySummary().eventCount).toBe(0);
    storage.block.write = false;
    await flushReadingActivityOutbox();
    expect(storage.values.get(key)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves another tab event while excluding quota-blocked acknowledgements', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const storage = mockActivityStorage();
    const key = 'aisu-bookhouse:reading-activity-outbox:ack-peer';
    storage.values.set(key, JSON.stringify([activityEvent('first-event', 30)]));
    setStoredSession({ id: 'ack-peer', nickname: 'A', role: 'user' });
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockImplementation(async (_url, options) => {
        if (JSON.parse(String(options.body)).event_id !== 'peer-event') throw new Error('Unexpected duplicate replay');
        return new Response('{}');
      });
    vi.stubGlobal('fetch', fetchMock);
    const pending = flushReadingActivityOutbox();
    storage.block.write = true;
    storage.values.set(key, JSON.stringify([activityEvent('first-event', 30), activityEvent('peer-event', 15)]));
    finish(new Response('{}'));
    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options.body)).event_id)).toEqual(['first-event', 'peer-event']);
    expect(getPendingReadingActivitySummary()).toEqual({ eventCount: 0, seconds: 0 });
    storage.block.write = false;
    await flushReadingActivityOutbox();
    expect(storage.values.get(key)).toBeUndefined();
  });

  it.each(['all', 'read', 'write'] as const)('keeps daily and book time independent across accounts when storage rejects %s access', (mode) => {
    const storage = mockActivityStorage();
    storage.block[mode] = true;
    const today = new Date(2026, 9, 26, 12);
    setStoredSession({ id: 'time-' + mode + '-a', nickname: 'A', role: 'user' });
    recordReadingActivity(30, today, 'book');
    recordReadingActivity(60, today, 'book');
    expect(getReadingActivitySummary(today).todaySeconds).toBe(90);
    expect(getBookReadingTime('book')).toBe(90);
    setStoredSession({ id: 'time-' + mode + '-b', nickname: 'B', role: 'user' });
    expect(getReadingActivitySummary(today).todaySeconds).toBe(0);
    expect(getBookReadingTime('book')).toBe(0);
    recordReadingActivity(15, today, 'book');
    setStoredSession({ id: 'time-' + mode + '-a', nickname: 'A', role: 'user' });
    expect(getReadingActivitySummary(today).todaySeconds).toBe(90);
    expect(getBookReadingTime('book')).toBe(90);
  });

  it('keeps accumulating after a quota error leaves older daily and book time on disk', () => {
    const storage = mockActivityStorage();
    const today = new Date(2026, 9, 26, 12);
    setStoredSession({ id: 'time-stale', nickname: 'A', role: 'user' });
    recordReadingActivity(60, today, 'book');
    storage.block.write = true;
    recordReadingActivity(30, today, 'book');
    recordReadingActivity(30, today, 'book');
    expect(getReadingActivitySummary(today).todaySeconds).toBe(120);
    expect(getBookReadingTime('book')).toBe(120);
    storage.block.write = false;
    recordReadingActivity(15, today, 'book');
    expect(getReadingActivitySummary(today).todaySeconds).toBe(135);
    expect(getBookReadingTime('book')).toBe(135);
    expect(readReadingActivityStore()['2026-10-26']).toBe(135);
    expect(readBookReadingTimeStore().book).toBe(135);
  });

  it.each([null, [], { book: '100' }, { book: -30 }, false, 42])('recovers invalid cached book time %j without corrupting new reading seconds', (stored) => {
    const storage = mockActivityStorage();
    const id = 'invalid-time-' + JSON.stringify(stored);
    storage.values.set('aisu-bookhouse:book-reading-time:' + id, JSON.stringify(stored));
    setStoredSession({ id, nickname: 'A', role: 'user' });
    expect(getBookReadingTime('book')).toBe(0);
    recordReadingActivity(30, new Date(2026, 9, 26, 12), 'book');
    expect(getBookReadingTime('book')).toBe(30);
  });

  it('does not overwrite unreadable history and adds current-session seconds after reads recover', () => {
    const storage = mockActivityStorage();
    const today = new Date(2026, 9, 26, 12);
    const dailyKey = 'aisu-bookhouse:reading-activity:read-history';
    const bookKey = 'aisu-bookhouse:book-reading-time:read-history';
    storage.values.set(dailyKey, JSON.stringify({ '2026-10-26': 600 }));
    storage.values.set(bookKey, JSON.stringify({ book: 300 }));
    storage.block.read = true;
    setStoredSession({ id: 'read-history', nickname: 'A', role: 'user' });
    recordReadingActivity(60, today, 'book');
    recordReadingActivity(60, today, 'book');
    expect(getReadingActivitySummary(today).todaySeconds).toBe(120);
    expect(getBookReadingTime('book')).toBe(120);
    expect(JSON.parse(storage.values.get(dailyKey)!)['2026-10-26']).toBe(600);
    expect(JSON.parse(storage.values.get(bookKey)!).book).toBe(300);
    storage.block.read = false;
    expect(getReadingActivitySummary(today).todaySeconds).toBe(720);
    expect(getBookReadingTime('book')).toBe(420);
    recordReadingActivity(30, today, 'book');
    expect(getReadingActivitySummary(today).todaySeconds).toBe(750);
    expect(getBookReadingTime('book')).toBe(450);
  });

  it('adds unsaved seconds to concurrent stored totals exactly once', async () => {
    const storage = mockActivityStorage();
    const today = new Date(2026, 9, 26, 12);
    setStoredSession({ id: 'concurrent-time', nickname: 'A', role: 'user' });
    recordReadingActivity(60, today, 'book');
    storage.block.write = true;
    recordReadingActivity(120, today, 'book');
    storage.block.write = false;
    vi.resetModules();
    const peer = await import('./readingActivity');
    peer.recordReadingActivity(540, today, 'book');
    peer.recordReadingActivity(300, today, 'other-book');
    storage.block.write = true;
    for (let i = 0; i < 3; i += 1) {
      expect(getReadingActivitySummary(today).todaySeconds).toBe(1020);
      expect(getBookReadingTime('book')).toBe(720);
    }
    storage.block.write = false;
    recordReadingActivity(30, today, 'book');
    expect(getReadingActivitySummary(today).todaySeconds).toBe(1050);
    expect(getBookReadingTime('book')).toBe(750);
  });

  it('keeps unreadable queued events on disk until they can be merged safely', async () => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const storage = mockActivityStorage();
    const key = 'aisu-bookhouse:reading-activity-outbox:read-outbox';
    storage.values.set(key, JSON.stringify([activityEvent('older-event', 30)]));
    storage.block.read = true;
    setStoredSession({ id: 'read-outbox', nickname: 'A', role: 'user' });
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(queueReadingActivitySync(15)).rejects.toThrow('offline');
    expect(JSON.parse(storage.values.get(key)!)[0].eventId).toBe('older-event');
    storage.block.read = false;
    expect(getPendingReadingActivitySummary()).toEqual({ eventCount: 2, seconds: 45 });
    await flushReadingActivityOutbox();
    const payloads = fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options.body)));
    expect(payloads[1].event_id).toBe('older-event');
    expect(payloads[2].event_id).toBe(payloads[0].event_id);
    expect(getPendingReadingActivitySummary()).toEqual({ eventCount: 0, seconds: 0 });
    expect(storage.values.get(key)).toBeUndefined();
  });
});

function activityEvent(eventId: string, seconds: number) {
  return { eventId, seconds, dateKey: '2026-10-26', occurredAt: '2026-10-26T04:00:00Z' };
}

function mockActivityStorage() {
  const values = new Map<string, string>();
  const block = { all: false, read: false, write: false };
  const activityKey = (key: string) => key.startsWith('aisu-bookhouse:reading-activity') || key.startsWith('aisu-bookhouse:book-reading-time');
  const storage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem(key: string) { if (block.read && activityKey(key)) throw new Error('Read blocked'); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (block.write && activityKey(key)) throw new Error('Quota exceeded'); values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
  vi.stubGlobal('window', { get localStorage() { if (block.all) throw new Error('Storage blocked'); return storage; } });
  return { values, block };
}
