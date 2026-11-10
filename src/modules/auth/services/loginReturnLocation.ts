import type { Location } from 'react-router-dom';

export type LoginReturnLocation = Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>;
const OAUTH_RETURN_KEY = 'aisu:oauth-return-location';

export function readOAuthReturnLocation(): LoginReturnLocation | undefined {
  try {
    const saved = sessionStorage.getItem(OAUTH_RETURN_KEY);
    return saved ? JSON.parse(saved) as LoginReturnLocation : undefined;
  } catch {
    return undefined;
  }
}

export function rememberOAuthReturnLocation(location?: LoginReturnLocation): void {
  try {
    if (location) sessionStorage.setItem(OAUTH_RETURN_KEY, JSON.stringify(location));
    else sessionStorage.removeItem(OAUTH_RETURN_KEY);
  } catch {
    // Returning to a page is optional; unavailable tab storage must not block sign-in.
  }
}
