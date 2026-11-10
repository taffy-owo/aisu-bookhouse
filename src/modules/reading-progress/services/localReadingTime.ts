import { notifyReadingActivityChanged } from './readingActivityCache';

type Seconds = Record<string, number>;
type Normalize = (value: unknown) => Seconds;
type Lane = { version: 1; id: string; epoch: string | null; totals: Seconds; closed: boolean };
type Reset = { version: 1; epoch: string; seed: Seconds };
type Checkpoint = { version: 1; epoch: string; totals: Seconds; covered: string[]; stamp: string };
type Counter = { active: Lane | null; pending: Map<string, Lane>; pendingReset?: Reset; memory: Seconds; epoch: string | null };
const counters = new Map<string, Counter>();
const compactions = new Map<string, Promise<void>>();
let observesPageHide = false;
let lockDatabase: Promise<IDBDatabase> | undefined;

function identity(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
function prefix(key: string): string { return 'aisu-bookhouse:reading-activity-local-v2:' + encodeURIComponent(key) + ':'; }
function epochPrefix(key: string, epoch: string): string { return prefix(key) + encodeURIComponent(epoch) + ':'; }
function laneKey(key: string, lane: Lane): string { return epochPrefix(key, lane.epoch!) + 'lane:' + encodeURIComponent(lane.id); }
function checkpointKey(key: string, epoch: string): string { return epochPrefix(key, epoch) + 'checkpoint'; }
function counter(key: string): Counter {
  let state = counters.get(key);
  if (!state) { state = { active: null, pending: new Map(), memory: {}, epoch: null }; counters.set(key, state); }
  return state;
}
function storage(): Storage {
  if (typeof window === 'undefined') throw Error('Storage unavailable');
  return window.localStorage;
}
function parse(raw: string | null): unknown {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function readReset(raw: string | null, normalize: Normalize): Reset | null {
  const value = parse(raw) as Partial<Reset> | null;
  return value?.version === 1 && typeof value.epoch === 'string' && value.epoch
    ? { version: 1, epoch: value.epoch, seed: normalize(value.seed) } : null;
}
function readCheckpoint(raw: string | null, epoch: string, normalize: Normalize): Checkpoint {
  const value = parse(raw) as Partial<Checkpoint> | null;
  return value?.version === 1 && value.epoch === epoch && Array.isArray(value.covered)
    && value.covered.every(id => typeof id === 'string') && typeof value.stamp === 'string'
    ? { version: 1, epoch, totals: normalize(value.totals), covered: value.covered, stamp: value.stamp }
    : { version: 1, epoch, totals: {}, covered: [], stamp: '' };
}
function readLanes(target: Storage, key: string, epoch: string, normalize: Normalize): Map<string, Lane> {
  const start = epochPrefix(key, epoch) + 'lane:';
  const names = Array.from({ length: target.length }, (_, index) => target.key(index)).filter((name): name is string => !!name?.startsWith(start));
  const lanes = new Map<string, Lane>();
  for (const name of names) {
    const lane = parse(target.getItem(name)) as Partial<Lane> | null;
    if (lane?.version === 1 && lane.epoch === epoch && typeof lane.id === 'string' && lane.id
      && typeof lane.closed === 'boolean' && name === start + encodeURIComponent(lane.id)) {
      lanes.set(lane.id, { version: 1, id: lane.id, epoch, totals: normalize(lane.totals), closed: lane.closed });
    }
  }
  return lanes;
}
function add(target: Seconds, source: Seconds): void {
  for (const [key, seconds] of Object.entries(source)) target[key] = (target[key] ?? 0) + seconds;
}
function persistPending(key: string, state: Counter, target: Storage): void {
  for (const [id, lane] of state.pending) {
    if (lane.epoch === null) continue;
    try { target.setItem(laneKey(key, lane), JSON.stringify(lane)); state.pending.delete(id); }
    catch { /* Only this writer's contribution remains unpublished. */ }
  }
}
function observePageHide(): void {
  if (observesPageHide || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  observesPageHide = true;
  window.addEventListener('pagehide', retireLocalReadingSeconds);
}

/** Call after flushing reader clocks, including a first tail emitted during pagehide. */
export function retireLocalReadingSeconds(): void {
  for (const [key, state] of counters) {
    if (!state.active) continue;
    state.active.closed = true;
    state.pending.set(state.active.id, state.active);
    state.active = null;
    try { persistPending(key, state, storage()); } catch { /* Retry a denied close after a cached page resumes. */ }
  }
}

export function readLocalReadingSeconds(key: string, normalize: Normalize): Seconds {
  const state = counter(key);
  try {
    const target = storage(), resetKey = prefix(key) + 'reset';
    if (state.pendingReset) {
      try { target.setItem(resetKey, JSON.stringify(state.pendingReset)); state.pendingReset = undefined; } catch { return { ...state.memory }; }
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const rawReset = target.getItem(resetKey), reset = readReset(rawReset, normalize);
      const epoch = reset?.epoch ?? 'initial';
      state.epoch = epoch;
      for (const lane of state.pending.values()) if (lane.epoch === null) lane.epoch = epoch;
      persistPending(key, state, target);
      const rawCheckpoint = target.getItem(checkpointKey(key, epoch));
      const checkpoint = readCheckpoint(rawCheckpoint, epoch, normalize);
      const lanes = readLanes(target, key, epoch, normalize);
      for (const lane of state.pending.values()) if (lane.epoch === epoch) lanes.set(lane.id, lane);
      const totals = { ...(reset?.seed ?? normalize(parse(target.getItem(key)))) };
      add(totals, checkpoint.totals);
      const covered = new Set(checkpoint.covered);
      for (const lane of lanes.values()) if (!covered.has(lane.id)) add(totals, lane.totals);
      // A compactor publishes coverage before removing closed contributions.
      // Retry if it crossed this read, so neither old nor new seconds vanish.
      if (target.getItem(resetKey) !== rawReset || target.getItem(checkpointKey(key, epoch)) !== rawCheckpoint) continue;
      state.memory = totals;
      if (checkpoint.covered.length || [...lanes.values()].some(lane => lane.closed)) scheduleCompaction(key, epoch, normalize);
      return { ...totals };
    }
  } catch { /* Keep the last complete summary while history cannot be read. */ }
  state.epoch = null;
  return { ...state.memory };
}

export function incrementLocalReadingSeconds(key: string, entry: string, seconds: number, normalize: Normalize): void {
  const totals = readLocalReadingSeconds(key, normalize), state = counter(key);
  observePageHide();
  if (state.active && state.active.epoch !== state.epoch) {
    state.active.closed = true;
    state.pending.set(state.active.id, state.active);
    state.active = null;
  }
  if (!state.active) state.active = { version: 1, id: identity(), epoch: state.epoch, totals: {}, closed: false };
  state.active.totals[entry] = (state.active.totals[entry] ?? 0) + seconds;
  state.pending.set(state.active.id, state.active);
  state.memory = { ...totals, [entry]: (totals[entry] ?? 0) + seconds };
  try { persistPending(key, state, storage()); } catch { /* Persist each unpublished writer independently after recovery. */ }
}

export function replaceLocalReadingSeconds(key: string, totals: Seconds): void {
  const state = counter(key), reset: Reset = { version: 1, epoch: identity(), seed: { ...totals } };
  state.active = null;
  state.pending.clear();
  state.pendingReset = reset;
  state.epoch = reset.epoch;
  state.memory = { ...totals };
  try {
    const target = storage();
    target.setItem(prefix(key) + 'reset', JSON.stringify(reset));
    state.pendingReset = undefined;
    // Older pages still expect this absolute seed. New readers use the reset
    // generation so an in-flight pre-reset contribution cannot reappear.
    target.setItem(key, JSON.stringify(totals));
  } catch { /* An explicit replacement remains available to this session. */ }
}

function withCompactionLock<T>(key: string, work: () => T): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request('aisu:local-reading-time:' + key, work);
  if (typeof indexedDB === 'undefined') return Promise.reject(Error('Cross-tab storage lock unavailable'));
  // An IndexedDB read/write transaction serializes compaction on browsers
  // without Web Locks. Writers never wait for it: their own keys remain safe.
  lockDatabase ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('aisu-bookhouse-reading-time-locks', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('mutex'); };
    request.onerror = () => { lockDatabase = undefined; reject(request.error); };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); lockDatabase = undefined; };
      resolve(database);
    };
  });
  return lockDatabase.then(database => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction('mutex', 'readwrite'), store = transaction.objectStore('mutex');
    let result: T;
    const request = store.get(key);
    request.onsuccess = () => {
      try { result = work(); store.put(1, key); } catch (error) { transaction.abort(); reject(error); }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? Error('Compaction aborted'));
  }));
}

function scheduleCompaction(key: string, epoch: string, normalize: Normalize): void {
  const scope = epochPrefix(key, epoch);
  if (compactions.has(scope)) return;
  const pending = Promise.resolve().then(() => withCompactionLock(scope, () => {
    const target = storage(), name = checkpointKey(key, epoch);
    const checkpoint = readCheckpoint(target.getItem(name), epoch, normalize);
    const lanes = readLanes(target, key, epoch, normalize), covered = new Set(checkpoint.covered);
    const additions = [...lanes.values()].filter(lane => lane.closed && !covered.has(lane.id));
    const totals = { ...checkpoint.totals };
    for (const lane of additions) { add(totals, lane.totals); covered.add(lane.id); }
    if (additions.length) target.setItem(name, JSON.stringify({ version: 1, epoch, totals, covered: [...covered], stamp: identity() } satisfies Checkpoint));
    let changed = additions.length > 0;
    for (const id of covered) {
      const lane = lanes.get(id);
      try {
        // Closed lanes are immutable; a resumed document creates a new lane.
        // Live writers' counters never participate in this cleanup.
        if (lane?.closed) target.removeItem(laneKey(key, lane));
        if (!target.getItem(scope + 'lane:' + encodeURIComponent(id))) { covered.delete(id); changed = true; }
      } catch { /* Coverage remains durable until this exact entry is removed. */ }
    }
    if (changed) target.setItem(name, JSON.stringify({ version: 1, epoch, totals, covered: [...covered], stamp: identity() } satisfies Checkpoint));
    return changed;
  })).then(changed => { if (changed) notifyReadingActivityChanged(); }).catch(() => {
    // Closed contributions still contain every second if compaction is denied.
  }).finally(() => { compactions.delete(scope); });
  compactions.set(scope, pending);
}
