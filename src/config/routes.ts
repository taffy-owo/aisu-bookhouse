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
  translations: '/translations',
  upload: '/upload',
} as const;

export function getTranslationTaskPath(taskId: string): string {
  return `${ROUTES.translations}?task=${encodeURIComponent(taskId)}`;
}

export function getBookDetailPath(bookId: string): string {
  return `/books/${bookId}`;
}

export function getNovelReaderPath(bookId: string): string {
  return `/reader/novel/${bookId}`;
}

export function getMangaReaderPath(bookId: string): string {
  return `/reader/manga/${bookId}`;
}
