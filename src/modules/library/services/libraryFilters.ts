import { BOOK_SORT_KEYS, type BookKind, type BookSortKey } from '../../books';

export type LibraryFilterKey = BookKind | 'all' | 'favorite' | 'recent' | 'finished' | 'unread' | 'disliked';

export interface LibraryFilterState {
  kind: LibraryFilterKey;
  query: string;
  sort: BookSortKey;
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilterState = {
  kind: 'all',
  query: '',
  sort: 'recent',
};

const KIND_VALUES: LibraryFilterKey[] = ['all', 'novel', 'manga', 'pdf', 'image', 'favorite', 'recent', 'finished', 'unread', 'disliked'];
const SORT_VALUES: readonly BookSortKey[] = BOOK_SORT_KEYS;

export function parseLibraryFilters(searchParams: URLSearchParams): LibraryFilterState {
  return {
    kind: parseLibraryKind(searchParams.get('kind')),
    query: searchParams.get('q')?.trim() ?? DEFAULT_LIBRARY_FILTERS.query,
    sort: parseLibrarySort(searchParams.get('sort')),
  };
}

export function createLibrarySearchParams(filters: LibraryFilterState): URLSearchParams {
  const searchParams = new URLSearchParams();

  if (filters.kind !== DEFAULT_LIBRARY_FILTERS.kind) {
    searchParams.set('kind', filters.kind);
  }
  if (filters.sort !== DEFAULT_LIBRARY_FILTERS.sort) {
    searchParams.set('sort', filters.sort);
  }
  if (filters.query.trim()) {
    searchParams.set('q', filters.query.trim());
  }

  return searchParams;
}

function parseLibraryKind(value: string | null): LibraryFilterKey {
  if (value && KIND_VALUES.includes(value as LibraryFilterKey)) {
    return value as LibraryFilterKey;
  }

  return DEFAULT_LIBRARY_FILTERS.kind;
}

function parseLibrarySort(value: string | null): BookSortKey {
  if (value && SORT_VALUES.includes(value as BookSortKey)) {
    return value as BookSortKey;
  }

  return DEFAULT_LIBRARY_FILTERS.sort;
}
