import { describe, expect, it } from 'vitest';
import { createLocationResetKey } from './locationResetKey';

describe('createLocationResetKey', () => {
  it('includes the path, query string, and hash', () => {
    expect(createLocationResetKey({ hash: '#chapter-2', pathname: '/library', search: '?q=sakura' })).toBe('/library?q=sakura#chapter-2');
  });

  it('changes when only search parameters change', () => {
    const first = createLocationResetKey({ hash: '', pathname: '/library', search: '?q=a' });
    const second = createLocationResetKey({ hash: '', pathname: '/library', search: '?q=b' });

    expect(first).not.toBe(second);
  });

  it('changes when only the hash changes', () => {
    const first = createLocationResetKey({ hash: '#page-1', pathname: '/reader/manga/book-1', search: '' });
    const second = createLocationResetKey({ hash: '#page-2', pathname: '/reader/manga/book-1', search: '' });

    expect(first).not.toBe(second);
  });
});
