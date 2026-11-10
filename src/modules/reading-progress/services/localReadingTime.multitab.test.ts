import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Activity = typeof import('./readingActivity');
const at = new Date(2026, 10, 2, 12);
let values: Map<string, string>;
async function tab(): Promise<Activity> { vi.resetModules(); return import('./readingActivity'); }

beforeEach(() => {
  values = new Map([['aisu-bookhouse:session', JSON.stringify({ id: 'local-peers', nickname: 'A', role: 'user' })]]);
  vi.stubGlobal('window', { localStorage: {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('local reading counters in independent tabs', () => {
  it.each([false, true])('preserves concurrent daily and book seconds, same book: %s', async sameBook => {
    const a = await tab(), b = await tab();
    const storage = window.localStorage, write = storage.setItem;
    let interleaved = false;
    storage.setItem = (key, value) => {
      if (!interleaved && key.startsWith('aisu-bookhouse:reading-activity')) {
        interleaved = true;
        b.recordReadingActivity(20, at, sameBook ? 'book-a' : 'book-b');
      }
      write(key, value);
    };
    a.recordReadingActivity(30, at, 'book-a');
    const reopened = await tab();
    expect(interleaved).toBe(true);
    expect(reopened.getReadingActivitySummary(at).todaySeconds).toBe(50);
    expect(reopened.getBookReadingTime('book-a')).toBe(sameBook ? 50 : 30);
    expect(reopened.getBookReadingTime('book-b')).toBe(sameBook ? 0 : 20);
  });

  it('adds old-version activity to new-window contributions without changing the original stored history', async () => {
    const dailyKey = 'aisu-bookhouse:reading-activity:local-peers';
    const bookKey = 'aisu-bookhouse:book-reading-time:local-peers';
    values.set(dailyKey, JSON.stringify({ '2026-11-02': 600 }));
    values.set(bookKey, JSON.stringify({ book: 300 }));
    const a = await tab();
    a.recordReadingActivity(30, at, 'book');
    // An older, still open page sees only its original store and adds its tail.
    values.set(dailyKey, JSON.stringify({ '2026-11-02': 620 }));
    values.set(bookKey, JSON.stringify({ book: 320 }));
    const reopened = await tab();
    expect(reopened.getReadingActivitySummary(at).todaySeconds).toBe(650);
    expect(reopened.getBookReadingTime('book')).toBe(350);
  });
});
