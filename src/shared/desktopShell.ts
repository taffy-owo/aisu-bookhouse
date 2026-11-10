const DESKTOP_SHELL_STORAGE_KEY = 'aisu-desktop-shell';

// The compact shell is the approved layout for both the browser and desktop
// clients. Keeping this as one switch makes it easy to revert the rollout
// without duplicating layout conditions across the app.
const COMPACT_SHELL_DEFAULT = true;

/** Keeps the compact layout marker across client-side route changes. */
export function isLegacyDesktopShell() {
  if (typeof window === 'undefined') return false;

  if (COMPACT_SHELL_DEFAULT) return true;

  const queryValue = new URLSearchParams(window.location.search).get('desktop_shell');
  if (queryValue === 'legacy') {
    try {
      window.sessionStorage.setItem(DESKTOP_SHELL_STORAGE_KEY, 'legacy');
    } catch {
      // Storage can be unavailable in privacy-restricted contexts.
    }
    return true;
  }

  try {
    return window.sessionStorage.getItem(DESKTOP_SHELL_STORAGE_KEY) === 'legacy';
  } catch {
    return false;
  }
}
