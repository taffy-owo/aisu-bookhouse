export function getBookCoverUrl(coverUrl: string | undefined, size: 'small' | 'medium' | 'large'): string | undefined {
  if (!coverUrl?.includes('/api/v1/files/books/')) return coverUrl;
  return `${coverUrl}${coverUrl.includes('?') ? '&' : '?'}size=${size}`;
}
