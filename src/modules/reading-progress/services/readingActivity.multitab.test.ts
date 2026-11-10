import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Activity = typeof import('./readingActivity');
const scope = 'aisu-bookhouse:reading-activity-outbox:shared-reader';
const prefix = 'aisu-bookhouse:reading-activity-outbox-v2:';
const readingDate = new Date('2026-11-01T12:00:00Z');

async function tab(): Promise<Activity> {
  vi.resetModules();
  return import('./readingActivity');
}

describe('reading activity shared by independent tabs', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_BACKEND_API', 'true');
    const values = new Map<string, string>();
    values.set('aisu-bookhouse:session', JSON.stringify({ id: 'shared-reader', nickname: 'A', role: 'user' }));
    vi.stubGlobal('window', { localStorage: {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('retains both offline events when two tabs enqueue during the same storage write', async () => {
    const a = await tab(), b = await tab();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const storage = window.localStorage, write = storage.setItem;
    let interleaved = false, peer: Promise<unknown> | undefined;
    storage.setItem = (key, value) => {
      if (!interleaved && (key === scope || key.startsWith(prefix))) {
        interleaved = true;
        peer = b.queueReadingActivitySync(20, readingDate, 'book-b').catch(() => {});
      }
      write(key, value);
    };
    await expect(a.queueReadingActivitySync(30, readingDate, 'book-a')).rejects.toThrow('offline');
    await peer;
    expect(interleaved).toBe(true);
    expect((await tab()).getPendingReadingActivitySummary()).toEqual({ eventCount: 2, seconds: 50 });
  });

  it('does not erase a peer event queued while cleaning up an older acknowledgement', async () => {
    const a = await tab(), b = await tab();
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockRejectedValue(new TypeError('offline')));
    const first = a.queueReadingActivitySync(30, readingDate, 'book-a').catch(() => {});
    const storage = window.localStorage, write = storage.setItem, remove = storage.removeItem;
    let interleaved = false, peer: Promise<unknown> | undefined;
    const enqueue = () => {
      interleaved = true;
      peer = b.queueReadingActivitySync(20, readingDate, 'book-b').catch(() => {});
    };
    storage.setItem = (key, value) => {
      if (!interleaved && key === scope && value === '[]') enqueue();
      write(key, value);
    };
    storage.removeItem = key => {
      if (!interleaved && key.startsWith(prefix)) enqueue();
      remove(key);
    };
    finish(Response.json({}));
    await first; await peer;
    expect(interleaved).toBe(true);
    expect((await tab()).getPendingReadingActivitySummary()).toEqual({ eventCount: 1, seconds: 20 });
  });

  it('does not revive a peer-acknowledged event while retaining a different quota-blocked event', async () => {
    const a = await tab(), b = await tab();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(a.queueReadingActivitySync(30, readingDate, 'book-a')).rejects.toThrow('offline');
    const storage = window.localStorage, write = storage.setItem;
    storage.setItem = (key, value) => { if (key.startsWith(prefix)) throw new Error('quota'); write(key, value); };
    await expect(a.queueReadingActivitySync(20, readingDate, 'book-b')).rejects.toThrow('offline');
    fetchMock.mockImplementation(async () => Response.json({}));
    await b.flushReadingActivityOutbox();
    expect(a.getPendingReadingActivitySummary()).toEqual({ eventCount: 1, seconds: 20 });
    storage.setItem = write;
    expect(a.getPendingReadingActivitySummary()).toEqual({ eventCount: 1, seconds: 20 });
    expect((await tab()).getPendingReadingActivitySummary()).toEqual({ eventCount: 1, seconds: 20 });
  });

  it('migrates legacy events without changing their identity while a peer adds a new event', async () => {
    const a = await tab(), b = await tab();
    const original = { bookId: 'legacy', dateKey: '2026-11-01', eventId: 'legacy-event', occurredAt: readingDate.toISOString(), seconds: 30 };
    window.localStorage.setItem(scope, JSON.stringify([original]));
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const storage = window.localStorage, write = storage.setItem;
    let interleaved = false, peer: Promise<unknown> | undefined;
    storage.setItem = (key, value) => {
      if (!interleaved && key.startsWith(prefix)) {
        interleaved = true;
        peer = b.queueReadingActivitySync(20, readingDate, 'book-b').catch(() => {});
      }
      write(key, value);
    };
    expect(a.getPendingReadingActivitySummary()).toEqual({ eventCount: 2, seconds: 50 });
    await peer;
    expect(storage.getItem(scope)).toBeNull();
    expect((await tab()).getPendingReadingActivitySummary()).toEqual({ eventCount: 2, seconds: 50 });
    fetchMock.mockImplementation(async () => Response.json({}));
    await a.flushReadingActivityOutbox();
    const payload = fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options.body)))
      .find(item => item.event_id === original.eventId);
    expect(payload).toMatchObject({ book_id: original.bookId, date_key: original.dateKey, occurred_at: original.occurredAt, seconds: 30 });
  });

  it('keeps valid current events readable and uploadable beside damaged legacy JSON', async () => {
    const a = await tab();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(a.queueReadingActivitySync(30, readingDate, 'book-a')).rejects.toThrow('offline');
    window.localStorage.setItem(scope, '{damaged');
    const reopened = await tab();
    expect(reopened.getPendingReadingActivitySummary()).toEqual({ eventCount: 1, seconds: 30 });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({})));
    await reopened.flushReadingActivityOutbox();
    expect(reopened.getPendingReadingActivitySummary()).toEqual({ eventCount: 0, seconds: 0 });
    expect(window.localStorage.getItem(scope)).toBe('{damaged');
  });
});
