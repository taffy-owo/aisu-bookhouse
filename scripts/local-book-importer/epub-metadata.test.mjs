import { describe, expect, it } from 'vitest';
import { safeDecodeHref } from './epub-metadata.mjs';

describe('epub metadata helpers', () => {
  it('decodes URL-encoded cover hrefs', () => {
    expect(safeDecodeHref('images/cover%20page.jpg')).toBe('images/cover page.jpg');
  });

  it('keeps malformed encoded hrefs unchanged', () => {
    expect(safeDecodeHref('images/cover%ZZ.jpg')).toBe('images/cover%ZZ.jpg');
  });
});
