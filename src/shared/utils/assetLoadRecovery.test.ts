import { afterEach, describe, expect, it, vi } from 'vitest';
import { canAttemptAssetReload, installAssetLoadRecovery, isAssetLoadError, recoverFromAssetLoadError } from './assetLoadRecovery';

afterEach(() => vi.unstubAllGlobals());

function recoveryWindow({ online = true, lastAttempt = null as string | null, blockedStorage = false } = {}) {
  const reload = vi.fn();
  const storage = new Map<string, string>(lastAttempt ? [['aisu.asset-reload-at', lastAttempt]] : []);
  const events = new EventTarget();
  const browser = {
    navigator: { onLine: online },
    location: { reload },
    sessionStorage: {
      getItem: vi.fn((key: string) => {
        if (blockedStorage) throw new Error('Storage unavailable');
        return storage.get(key) ?? null;
      }),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    },
    addEventListener: events.addEventListener.bind(events),
  };
  vi.stubGlobal('window', browser);
  return { ...browser, events, reload, storage };
}

describe('isAssetLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://example.test/assets/LibraryPage-old.js',
    'Importing a module script failed.',
    'ChunkLoadError: Loading chunk 42 failed',
    'Unable to preload CSS for /assets/page-old.css',
  ])('recognizes stale deployment assets: %s', (message) => {
    expect(isAssetLoadError(new TypeError(message))).toBe(true);
  });

  it('does not hide ordinary application errors', () => {
    expect(isAssetLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});

describe('canAttemptAssetReload', () => {
  it('allows the first recovery and attempts after the cooldown', () => {
    expect(canAttemptAssetReload(null, 100_000)).toBe(true);
    expect(canAttemptAssetReload('30000', 100_000)).toBe(true);
  });

  it('blocks reload loops during the cooldown', () => {
    expect(canAttemptAssetReload('70000', 100_000)).toBe(false);
  });
});

describe('asset recovery effects', () => {
  const failure = new TypeError('Failed to fetch dynamically imported module: /assets/page.js');

  it('reloads once and records the attempt before another error can repeat it', () => {
    const browser = recoveryWindow();
    expect(recoverFromAssetLoadError(failure)).toBe(true);
    expect(browser.reload).toHaveBeenCalledOnce();
    expect(Number(browser.storage.get('aisu.asset-reload-at'))).toBeGreaterThan(0);
    expect(recoverFromAssetLoadError(failure)).toBe(false);
    expect(browser.reload).toHaveBeenCalledOnce();
  });

  it('keeps the loaded app and the retry allowance intact while offline', () => {
    const browser = recoveryWindow({ online: false });
    expect(recoverFromAssetLoadError(failure)).toBe(false);
    expect(browser.reload).not.toHaveBeenCalled();
    expect(browser.sessionStorage.setItem).not.toHaveBeenCalled();
    browser.navigator.onLine = true;
    expect(recoverFromAssetLoadError(failure)).toBe(true);
    expect(browser.reload).toHaveBeenCalledOnce();
  });

  it('does not turn unrelated application failures into automatic reloads', () => {
    const browser = recoveryWindow();
    expect(recoverFromAssetLoadError(new Error('Invalid book state'))).toBe(false);
    expect(browser.reload).not.toHaveBeenCalled();
    expect(browser.sessionStorage.getItem).not.toHaveBeenCalled();
  });

  it('keeps the error visible when storage cannot enforce the reload limit', () => {
    const browser = recoveryWindow({ blockedStorage: true });
    expect(recoverFromAssetLoadError(failure)).toBe(false);
    expect(browser.reload).not.toHaveBeenCalled();
  });

  it('prevents the preload error only when it can begin recovery', () => {
    const browser = recoveryWindow();
    installAssetLoadRecovery();
    const first = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: failure });
    browser.events.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(browser.reload).toHaveBeenCalledOnce();
    const second = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: failure });
    browser.events.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    expect(browser.reload).toHaveBeenCalledOnce();
  });

  it('does not suppress an offline preload error that needs visible feedback', () => {
    const browser = recoveryWindow({ online: false });
    installAssetLoadRecovery();
    const event = new Event('vite:preloadError', { cancelable: true });
    browser.events.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(browser.reload).not.toHaveBeenCalled();
  });
});
