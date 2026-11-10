import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthStorage, getAccountScope, setStoredSession } from '../../../shared/api';
import { readCloudReadingActivityCache, saveCloudReadingActivityCache } from './readingActivityCache';

const summary = { days: [{ date_key: '2026-10-24', seconds: 600 }], book_totals: [{ book_id: 'private-book', book_title: '私藏书', seconds: 600 }], active_days: 1, first_read_date: '2026-10-24', last_read_date: '2026-10-24', longest_streak_days: 1, streak_days: 1, today_seconds: 600, week_seconds: 600, total_seconds: 600 };
let sequence = 0;
let store: Map<string, string>;
let id: string;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) } });
  id = `cache-account-${++sequence}`;
  setStoredSession({ id, nickname: 'A', role: 'user' });
});
afterEach(() => { clearAuthStorage(); vi.unstubAllGlobals(); });

describe('cloud reading activity cache', () => {
  it('preserves a successful summary independently of the page that read it', () => {
    saveCloudReadingActivityCache(summary);
    expect(readCloudReadingActivityCache()).toEqual(summary);
    expect(JSON.parse(store.get(`aisu-bookhouse:cloud-reading-activity:${id}`)!)).toMatchObject({ version: 1, accountScope: getAccountScope(), summary });
  });
  it('cannot expose another account or accept its late write', () => {
    const oldScope = getAccountScope();
    saveCloudReadingActivityCache(summary);
    setStoredSession({ id: `${id}-b`, nickname: 'B', role: 'user' });
    expect(readCloudReadingActivityCache()).toBeNull();
    expect(readCloudReadingActivityCache(oldScope)).toBeNull();
    saveCloudReadingActivityCache(summary, oldScope);
    expect(readCloudReadingActivityCache()).toBeNull();
  });
  it('retains the current-session summary when storage rejects writes or reads', () => {
    Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('blocked'); } });
    saveCloudReadingActivityCache(summary);
    expect(readCloudReadingActivityCache()).toEqual(summary);
  });
  it('does not let an older readable cache replace a newer summary after a quota failure', () => {
    saveCloudReadingActivityCache(summary);
    const storage = window.localStorage;
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (key.startsWith('aisu-bookhouse:cloud-reading-activity:')) throw new Error('quota');
      setItem(key, value);
    };
    const updated = { ...summary, days: [{ date_key: '2026-10-24', seconds: 1200 }], today_seconds: 1200, week_seconds: 1200, total_seconds: 1200 };
    saveCloudReadingActivityCache(updated);
    expect(readCloudReadingActivityCache()?.total_seconds).toBe(1200);
  });
  it.each(['{broken', 'null', JSON.stringify({ version: 1, accountScope: '"wrong"', savedAt: 1, summary }), JSON.stringify({ version: 1, savedAt: 1, summary: { days: null } })])('ignores damaged or foreign cached data: %s', (raw) => {
    store.set(`aisu-bookhouse:cloud-reading-activity:${id}`, raw);
    expect(readCloudReadingActivityCache()).toBeNull();
  });
  it('does not replace valid data with malformed dates or counts', () => {
    saveCloudReadingActivityCache(summary);
    saveCloudReadingActivityCache({ ...summary, days: [{ date_key: '2026-02-30', seconds: 30 }] });
    saveCloudReadingActivityCache({ ...summary, total_seconds: Number.NaN });
    expect(readCloudReadingActivityCache()).toEqual(summary);
  });
});
