const ASSET_RELOAD_ATTEMPT_KEY = 'aisu.asset-reload-at';
const ASSET_RELOAD_COOLDOWN_MS = 60_000;

const ASSET_LOAD_ERROR_PATTERNS = [
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'chunkloaderror',
  'unable to preload css',
];

export function isAssetLoadError(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  const normalizedMessage = message.toLowerCase();

  return ASSET_LOAD_ERROR_PATTERNS.some((pattern) => normalizedMessage.includes(pattern));
}

export function canAttemptAssetReload(lastAttempt: string | null, now = Date.now()) {
  const lastAttemptAt = Number(lastAttempt);
  return !Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0 || now - lastAttemptAt >= ASSET_RELOAD_COOLDOWN_MS;
}

export function recoverFromAssetLoadError(error: unknown, force = false) {
  if (!force && !isAssetLoadError(error)) {
    return false;
  }

  if (window.navigator.onLine === false) {
    return false;
  }

  try {
    const lastAttempt = window.sessionStorage.getItem(ASSET_RELOAD_ATTEMPT_KEY);
    if (!canAttemptAssetReload(lastAttempt)) {
      return false;
    }
    window.sessionStorage.setItem(ASSET_RELOAD_ATTEMPT_KEY, String(Date.now()));
  } catch {
    return false;
  }

  window.location.reload();
  return true;
}

export function installAssetLoadRecovery() {
  window.addEventListener('vite:preloadError', (event) => {
    const preloadError = event as Event & { payload?: unknown };
    if (recoverFromAssetLoadError(preloadError.payload, true)) {
      event.preventDefault();
    }
  });
}
