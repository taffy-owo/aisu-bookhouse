import { describe, expect, it } from 'vitest';
import { getPagedReadingLayout } from './pagedReadingLayout';

describe('paged reading geometry', () => {
  it('identifies a partial final page without rounding it back a page', () => {
    expect(getPagedReadingLayout(1000, 1800, 800)).toMatchObject({ currentPage: 3, pageCount: 3, maxScrollTop: 1000 });
    expect(getPagedReadingLayout(999.5, 1800, 800).currentPage).toBe(3);
  });
  it('does not call the first page of a short chapter its final page before reaching the end', () => {
    expect(getPagedReadingLayout(0, 1000, 800)).toMatchObject({ currentPage: 1, pageCount: 2 });
    expect(getPagedReadingLayout(200, 1000, 800).currentPage).toBe(2);
  });
  it('measures a restored position between page boundaries without skipping unread text', () => {
    const layout = getPagedReadingLayout(1200, 4000, 864);
    expect(layout).toMatchObject({ currentPage: 2, pageStep: 816 });
    const nextPosition = Math.min(layout.maxScrollTop, 1200 + layout.pageStep);
    expect(nextPosition - 1200).toBeLessThan(864);
    expect(nextPosition).toBe(2016);
    expect(getPagedReadingLayout(400, 4000, 864)).toMatchObject({ currentPage: 1, isAtStart: false });
  });
  it('keeps an empty or viewport-sized chapter on page one', () => {
    expect(getPagedReadingLayout(0, 800, 800)).toMatchObject({ currentPage: 1, pageCount: 1 });
    expect(getPagedReadingLayout(-12, 400, 800)).toMatchObject({ currentPage: 1, pageCount: 1 });
  });
});
