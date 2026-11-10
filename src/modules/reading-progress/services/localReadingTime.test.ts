import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { incrementLocalReadingSeconds, readLocalReadingSeconds, replaceLocalReadingSeconds } from './localReadingTime';

let sequence = 0, key: string, values: Map<string, string>;
const normalize = (value: unknown): Record<string, number> => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([, seconds]) => typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0)) : {};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const retire = () => window.dispatchEvent(new Event('pagehide'));

beforeEach(() => {
  key = 'local-counter-' + ++sequence;
  values = new Map();
  const events = new EventTarget();
  vi.stubGlobal('window', Object.assign(events, { localStorage: {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
    removeItem: (name: string) => { values.delete(name); },
  } }));
  vi.stubGlobal('navigator', { locks: { request: (_name: string, work: () => unknown) => Promise.resolve().then(work) } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('durable local reading counter compaction', () => {
  it('compacts closed documents while a resumed document contributes only its new seconds', async () => {
    // Each new module owns its pagehide listener, as a real document does.
    vi.resetModules();
    const page = await import('./localReadingTime');
    page.incrementLocalReadingSeconds(key, 'book', 60, normalize);
    retire();
    expect(page.readLocalReadingSeconds(key, normalize).book).toBe(60);
    await settle();
    page.incrementLocalReadingSeconds(key, 'book', 15, normalize);
    expect(page.readLocalReadingSeconds(key, normalize).book).toBe(75);
    expect([...values.keys()].filter(name => name.includes('lane:'))).toHaveLength(1);
    expect([...values.keys()].filter(name => name.endsWith('checkpoint'))).toHaveLength(1);
  });

  it('retains durable coverage when deleting a compacted entry fails, without counting it twice', async () => {
    vi.resetModules(); const page = await import('./localReadingTime');
    page.incrementLocalReadingSeconds(key, 'book', 60, normalize); retire();
    const target = window.localStorage, remove = target.removeItem;
    target.removeItem = () => { throw Error('delete denied'); };
    page.readLocalReadingSeconds(key, normalize); await settle();
    for (let index = 0; index < 3; index++) expect(page.readLocalReadingSeconds(key, normalize).book).toBe(60);
    await settle();
    target.removeItem = remove;
    page.readLocalReadingSeconds(key, normalize); await settle();
    vi.resetModules();
    expect((await import('./localReadingTime')).readLocalReadingSeconds(key, normalize).book).toBe(60);
    expect([...values.keys()].filter(name => name.includes('lane:'))).toHaveLength(0);
  });

  it('never removes the original contribution when its compacted total cannot be saved', async () => {
    vi.resetModules(); const page = await import('./localReadingTime');
    page.incrementLocalReadingSeconds(key, 'book', 60, normalize); retire();
    const target = window.localStorage, write = target.setItem;
    target.setItem = (name, value) => { if (name.endsWith('checkpoint')) throw Error('quota'); write(name, value); };
    page.readLocalReadingSeconds(key, normalize); await settle();
    expect([...values.keys()].filter(name => name.includes('lane:'))).toHaveLength(1);
    vi.resetModules(); const reopened = await import('./localReadingTime');
    expect(reopened.readLocalReadingSeconds(key, normalize).book).toBe(60);
    await settle(); target.setItem = write;
    reopened.readLocalReadingSeconds(key, normalize); await settle();
    expect(reopened.readLocalReadingSeconds(key, normalize).book).toBe(60);
    expect([...values.keys()].filter(name => name.includes('lane:'))).toHaveLength(0);
  });

  it('preserves a live peer increment made while another document compacts its closed counters', async () => {
    vi.resetModules(); const a = await import('./localReadingTime');
    vi.resetModules(); const b = await import('./localReadingTime');
    a.incrementLocalReadingSeconds(key, 'book', 60, normalize); retire();
    const target = window.localStorage, write = target.setItem;
    let interleaved = false;
    target.setItem = (name, value) => {
      if (!interleaved && name.endsWith('checkpoint')) { interleaved = true; b.incrementLocalReadingSeconds(key, 'book', 20, normalize); }
      write(name, value);
    };
    a.readLocalReadingSeconds(key, normalize); await settle();
    vi.resetModules();
    expect(interleaved).toBe(true);
    expect((await import('./localReadingTime')).readLocalReadingSeconds(key, normalize).book).toBe(80);
  });

  it('retries a read crossed by checkpoint publication and removal of its original entry', async () => {
    vi.resetModules(); const a = await import('./localReadingTime');
    a.incrementLocalReadingSeconds(key, 'book', 60, normalize); retire();
    let compact: (() => unknown) | undefined;
    vi.stubGlobal('navigator', { locks: { request: (_name: string, work: () => unknown) => new Promise(resolve => { compact = () => resolve(work()); }) } });
    a.readLocalReadingSeconds(key, normalize); await settle();
    const target = window.localStorage, read = target.getItem;
    let interleaved = false;
    target.getItem = name => {
      if (!interleaved && name.includes('lane:')) { interleaved = true; compact!(); }
      return read(name);
    };
    vi.resetModules(); const b = await import('./localReadingTime');
    expect(b.readLocalReadingSeconds(key, normalize).book).toBe(60);
    expect(interleaved).toBe(true);
    await settle();
  });

  it('keeps an explicit replacement when an older contribution finishes writing later', () => {
    const target = window.localStorage, write = target.setItem;
    let interleaved = false;
    target.setItem = (name, value) => {
      if (!interleaved && name.includes('lane:')) { interleaved = true; replaceLocalReadingSeconds(key, { book: 10 }); }
      write(name, value);
    };
    incrementLocalReadingSeconds(key, 'book', 60, normalize);
    expect(readLocalReadingSeconds(key, normalize).book).toBe(10);
  });
});
