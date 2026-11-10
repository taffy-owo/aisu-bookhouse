export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || (typeof error === 'object' && error !== null && 'name' in error && (error as { name?: unknown }).name === 'AbortError');
}
