import { describe, expect, it } from 'vitest';
import { createLibrarySearchParams, parseLibraryFilters } from './libraryFilters';

describe('libraryFilters', () => {
  it('parses supported URL filter parameters', () => {
    const filters = parseLibraryFilters(new URLSearchParams('kind=manga&sort=title&q=%E6%98%9F'));

    expect(filters).toEqual({
      kind: 'manga',
      query: '星',
      sort: 'title',
    });
  });

  it('falls back when URL filter parameters are invalid', () => {
    const filters = parseLibraryFilters(new URLSearchParams('kind=bad&sort=bad&q='));

    expect(filters).toEqual({
      kind: 'all',
      query: '',
      sort: 'recent',
    });
  });

  it('parses the disliked shelf category', () => {
    expect(parseLibraryFilters(new URLSearchParams('kind=disliked')).kind).toBe('disliked');
  });

  it('ignores legacy tag parameters left over from old URLs', () => {
    const filters = parseLibraryFilters(new URLSearchParams('kind=manga&tag=%E6%A0%A1%E5%9B%AD'));

    expect(filters).toEqual({
      kind: 'manga',
      query: '',
      sort: 'recent',
    });
  });

  it('creates stable URL parameters without default values', () => {
    const searchParams = createLibrarySearchParams({
      kind: 'favorite',
      query: '  告白  ',
      sort: 'progress',
    });

    expect(searchParams.toString()).toBe('kind=favorite&sort=progress&q=%E5%91%8A%E7%99%BD');
  });
});
