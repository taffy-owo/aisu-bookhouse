import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApiResourceUrl, buildApiUrl, isApiResourceUrl } from './apiConfig';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildApiUrl', () => {
  it('keeps absolute API URLs unchanged', () => {
    expect(buildApiUrl('http://127.0.0.1:8000/api/v1/files/books/book-1/cover')).toBe('http://127.0.0.1:8000/api/v1/files/books/book-1/cover');
  });

  it('does not duplicate the API base when a relative API resource is downloaded', () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api/v1');

    expect(buildApiUrl('/api/v1/files/books/book-1/cover')).toBe('/api/v1/files/books/book-1/cover');
  });
});

describe('buildApiResourceUrl', () => {
  it('resolves backend API-relative asset paths against the API origin', () => {
    expect(buildApiResourceUrl('/api/v1/files/books/book-1/cover')).toBe('/api/v1/files/books/book-1/cover');
  });

  it('keeps backend API-relative asset paths relative when the API base is relative', () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api/v1');

    expect(buildApiResourceUrl('/api/v1/files/books/book-1/cover')).toBe('/api/v1/files/books/book-1/cover');
  });

  it('keeps frontend static asset paths relative to the current app', () => {
    expect(buildApiResourceUrl('/assets/imported-covers/book.jpg')).toBe('/assets/imported-covers/book.jpg');
  });

  it('keeps absolute resource URLs unchanged', () => {
    expect(buildApiResourceUrl('https://example.com/cover.jpg')).toBe('https://example.com/cover.jpg');
  });
});

describe('isApiResourceUrl', () => {
  it('detects backend API resource URLs that need authenticated fetching', () => {
    expect(isApiResourceUrl('/api/v1/files/books/book-1/cover')).toBe(true);
    expect(isApiResourceUrl('http://127.0.0.1:8000/api/v1/files/books/book-1/cover')).toBe(true);
    expect(isApiResourceUrl('/assets/imported-covers/book.jpg')).toBe(false);
  });

  it('detects backend resources when the API base is relative', () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api/v1');

    expect(isApiResourceUrl('/api/v1/files/books/book-1/cover')).toBe(true);
    expect(isApiResourceUrl('https://your-domain.example/api/v1/files/books/book-1/cover')).toBe(true);
  });
});
