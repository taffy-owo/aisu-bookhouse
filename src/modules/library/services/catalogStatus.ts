interface ActiveChapterInput {
  chapterCount: number;
  progressPercent: number;
  savedChapterIndex?: number;
}

interface ActivePageInput {
  pageCount: number;
  progressPercent: number;
  savedPageIndex?: number;
}

export function resolveActiveChapterIndex({ chapterCount, progressPercent, savedChapterIndex }: ActiveChapterInput): number | null {
  return resolveActiveIndex({
    count: chapterCount,
    progressPercent,
    savedIndex: savedChapterIndex,
  });
}

export function resolveActivePageIndex({ pageCount, progressPercent, savedPageIndex }: ActivePageInput): number | null {
  return resolveActiveIndex({
    count: pageCount,
    progressPercent,
    savedIndex: savedPageIndex,
  });
}

function resolveActiveIndex({ count, progressPercent, savedIndex }: { count: number; progressPercent: number; savedIndex?: number }): number | null {
  const safeCount = Math.floor(count);

  if (safeCount <= 0) {
    return null;
  }

  if (Number.isInteger(savedIndex) && savedIndex && savedIndex > 0) {
    return clampIndex(savedIndex, safeCount);
  }

  const safeProgress = Math.min(100, Math.max(0, progressPercent));

  if (safeProgress <= 0) {
    return null;
  }

  if (safeProgress >= 100) {
    return safeCount;
  }

  return clampIndex(Math.floor((safeProgress / 100) * safeCount) + 1, safeCount);
}

function clampIndex(index: number, count: number): number {
  return Math.min(count, Math.max(1, index));
}
