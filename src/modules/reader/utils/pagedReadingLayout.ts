export const PAGE_OVERLAP_PX = 48;

export function getPagedReadingLayout(scrollTop: number, scrollHeight: number, viewportHeight: number) {
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  const pageStep = Math.max(1, viewportHeight - PAGE_OVERLAP_PX);
  const pageCount = maxScrollTop <= 1 ? 1 : Math.ceil(maxScrollTop / pageStep) + 1;
  const position = Math.max(0, Math.min(maxScrollTop, scrollTop));
  const currentPage = maxScrollTop <= 1 ? 1 : position >= maxScrollTop - 1 ? pageCount : Math.min(pageCount, Math.floor(position / pageStep) + 1);
  return { currentPage, maxScrollTop, pageCount, pageStep, isAtStart: position <= 1, isAtEnd: position >= maxScrollTop - 1 };
}
