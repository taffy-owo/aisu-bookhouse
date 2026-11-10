import type { BookListResult } from '../../books';

/** Build one complete replacement before updating a visible, paginated shelf. */
export async function loadBookListWindow(
  loadPage: (page: number) => Promise<BookListResult>,
  pageCount: number,
  signal: AbortSignal,
): Promise<BookListResult> {
  signal.throwIfAborted();
  let result = await loadPage(1);
  signal.throwIfAborted();
  const books = [...result.books];
  const ids = new Set(books.map((book) => book.id));
  for (let page = 2; page <= pageCount && result.hasMore; page += 1) {
    const next = await loadPage(page);
    signal.throwIfAborted();
    // An offset page can move during a refresh. Keep the visible snapshot and
    // offer a retry instead of replacing it with a partial or duplicate list.
    if (next.total !== result.total || next.page !== page || next.books.some((book) => ids.has(book.id))) {
      throw new Error('图书列表正在变化，请重试更新。');
    }
    next.books.forEach((book) => ids.add(book.id));
    books.push(...next.books);
    result = next;
  }
  return { ...result, books };
}

/** Capture just before committing new rows, so scrolling during the fetch stays free. */
export function captureCollectionAnchor(selector: string): () => void {
  const root = document.querySelector(selector);
  const y = window.scrollY;
  if (!root || y <= 0 || document.body.style.position === 'fixed') return () => {};
  const anchors = [...root.querySelectorAll<HTMLElement>('[data-book-id]')]
    .filter((book) => book.getBoundingClientRect().bottom > 120)
    .slice(0, 3)
    .map((book) => ({ id: book.dataset.bookId, top: book.getBoundingClientRect().top }));
  return () => {
    if (!root.isConnected || document.body.style.position === 'fixed') return;
    const books = [...root.querySelectorAll<HTMLElement>('[data-book-id]')];
    for (const anchor of anchors) {
      const book = books.find((item) => item.dataset.bookId === anchor.id);
      if (book) {
        window.scrollTo({ top: window.scrollY + book.getBoundingClientRect().top - anchor.top, behavior: 'instant' });
        return;
      }
    }
    window.scrollTo({ top: y, behavior: 'instant' });
  };
}
