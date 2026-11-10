import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudReadingActivitySummary } from './readingActivity';

type Cache = typeof import('./readingActivityCache');
const id = 'snapshot-peers';
const key = 'aisu-bookhouse:cloud-reading-activity:' + id;
const scope = JSON.stringify(id);
let values: Map<string, string>;

async function tab(): Promise<Cache> {
  vi.resetModules();
  return import('./readingActivityCache');
}

beforeEach(() => {
  values = new Map([['aisu-bookhouse:session', JSON.stringify({ id, nickname: 'A', role: 'user' })]]);
  vi.stubGlobal('window', { localStorage: {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
    removeItem: (name: string) => { values.delete(name); },
  } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('acknowledged reading activity snapshots across tabs', () => {
  it('preserves a newer peer snapshot when an older response writes during the same storage operation', async () => {
    const a = await tab(), b = await tab();
    a.saveCloudReadingActivityCache(summary(600));
    const storage = window.localStorage, write = storage.setItem;
    let interleaved = false;
    storage.setItem = (name, value) => {
      if (!interleaved && name.startsWith(key)) {
        interleaved = true;
        b.saveCloudReadingActivityCache(summary(690));
      }
      write(name, value);
    };
    a.saveCloudReadingActivityCache(summary(630));
    expect(interleaved).toBe(true);
    expect((await tab()).readCloudReadingActivityCache()?.total_seconds).toBe(690);
    expect(a.readCloudReadingActivityCache()?.book_totals[0].seconds).toBe(690);
  });

  it('never regresses to a stale legacy write from an already open page', async () => {
    const current = await tab();
    current.saveCloudReadingActivityCache(summary(690));
    values.set(key, JSON.stringify({ version: 1, accountScope: scope, savedAt: Date.now() + 1000, summary: summary(630) }));
    expect((await tab()).readCloudReadingActivityCache()?.total_seconds).toBe(690);
  });

  it('keeps a larger in-memory snapshot after quota failure even when a peer writes later', async () => {
    const a = await tab(), b = await tab();
    a.saveCloudReadingActivityCache(summary(600));
    const storage = window.localStorage, write = storage.setItem;
    storage.setItem = () => { throw Error('quota'); };
    a.saveCloudReadingActivityCache(summary(690));
    storage.setItem = write;
    b.saveCloudReadingActivityCache(summary(630));
    expect(a.readCloudReadingActivityCache()?.total_seconds).toBe(690);
    a.saveCloudReadingActivityCache(summary(690));
    expect((await tab()).readCloudReadingActivityCache()?.total_seconds).toBe(690);
  });

  it('allows calendar rollover metadata to change without adding reading time', async () => {
    const cache = await tab();
    cache.saveCloudReadingActivityCache(summary(600));
    const nextDay = { ...summary(600), today_seconds: 0, streak_days: 1 };
    cache.saveCloudReadingActivityCache(nextDay);
    expect((await tab()).readCloudReadingActivityCache()).toEqual(nextDay);
  });

  it('bounds persisted snapshots while retaining the most recent confirmed total', async () => {
    const cache = await tab();
    for (let seconds = 600; seconds < 650; seconds++) cache.saveCloudReadingActivityCache(summary(seconds));
    expect([...values.keys()].filter(name => name.startsWith(key)).length).toBeLessThanOrEqual(2);
    expect((await tab()).readCloudReadingActivityCache()?.total_seconds).toBe(649);
  });
});

function summary(seconds: number): CloudReadingActivitySummary {
  return { active_days: 1, book_totals: [{ book_id: 'book', book_title: '测试书', seconds }],
    days: [{ date_key: '2026-11-02', seconds }], first_read_date: '2026-11-02', last_read_date: '2026-11-02',
    longest_streak_days: 1, streak_days: 1, today_seconds: seconds, total_seconds: seconds, week_seconds: seconds };
}
