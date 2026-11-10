export function clampChapterIndex(index: number, chapterCount: number): number {
  return Math.min(Math.max(1, index), chapterCount);
}

export function parseRequestedChapterIndex(searchParams: URLSearchParams): number | null {
  const requestedChapterIndex = Number(searchParams.get('chapter'));

  return Number.isInteger(requestedChapterIndex) && requestedChapterIndex > 0 ? requestedChapterIndex : null;
}
