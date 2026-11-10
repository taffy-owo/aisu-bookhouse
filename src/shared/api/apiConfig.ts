// Same-origin is the safe production default. Local development can opt into
// a separate API origin through the documented VITE_API_BASE_URL setting.
const DEFAULT_API_BASE_URL = '/api/v1';

export function getApiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_API_BASE_URL;
}

export function isBackendApiEnabled(): boolean {
  if (import.meta.env.MODE === 'test') {
    return import.meta.env.VITE_USE_BACKEND_API === 'true';
  }

  return import.meta.env.VITE_USE_BACKEND_API !== 'false';
}

export function buildApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const baseUrl = getApiBaseUrl().replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const basePath = getApiBasePath(baseUrl);

  if (baseUrl.startsWith('/') && (normalizedPath === basePath || normalizedPath.startsWith(`${basePath}/`))) {
    return normalizedPath;
  }

  return `${baseUrl}${normalizedPath}`;
}

export function buildApiResourceUrl(pathOrUrl: string | null | undefined): string | undefined {
  if (!pathOrUrl) {
    return undefined;
  }

  if (/^(https?:|data:|blob:)/i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  if (pathOrUrl.startsWith('/api/')) {
    const apiOrigin = getAbsoluteApiOrigin();
    return apiOrigin ? `${apiOrigin}${pathOrUrl}` : pathOrUrl;
  }

  if (pathOrUrl.startsWith('/')) {
    return pathOrUrl;
  }

  return buildApiUrl(pathOrUrl);
}

export function isApiResourceUrl(pathOrUrl: string | null | undefined): boolean {
  if (!pathOrUrl) {
    return false;
  }

  if (pathOrUrl.startsWith('/api/')) {
    return true;
  }

  if (!/^https?:\/\//i.test(pathOrUrl)) {
    return false;
  }

  const resourceUrl = new URL(pathOrUrl);
  const apiBaseUrl = getApiBaseUrl();
  const absoluteApiOrigin = getAbsoluteApiOrigin();
  const apiBasePath = getApiBasePath(apiBaseUrl);

  if (absoluteApiOrigin) {
    return resourceUrl.origin === absoluteApiOrigin && resourceUrl.pathname.startsWith(`${apiBasePath}/`);
  }

  if (typeof window !== 'undefined' && resourceUrl.origin !== window.location.origin) {
    return false;
  }

  return resourceUrl.pathname.startsWith(`${apiBasePath}/`);
}

function getAbsoluteApiOrigin(): string | null {
  try {
    return new URL(getApiBaseUrl()).origin;
  } catch {
    return null;
  }
}

function getApiBasePath(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).pathname.replace(/\/$/, '');
  } catch {
    const normalizedPath = apiBaseUrl.startsWith('/') ? apiBaseUrl : `/${apiBaseUrl}`;
    return normalizedPath.replace(/\/$/, '');
  }
}
