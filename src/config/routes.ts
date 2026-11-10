export const ROUTES = {
  adminUsers: '/admin/users',
  apiDocs: '/api-docs',
  home: '/',
  library: '/library',
  japanese: '/japanese',
  login: '/login',
  profile: '/me',
  publicLibrary: '/public',
  settings: '/settings',
  upload: '/upload',
} as const;

export function getBookDetailPath(bookId: string): string {
  return `/books/${bookId}`;
}

export function getNovelReaderPath(bookId: string): string {
  return `/reader/novel/${bookId}`;
}

export function getMangaReaderPath(bookId: string): string {
  return `/reader/manga/${bookId}`;
}
