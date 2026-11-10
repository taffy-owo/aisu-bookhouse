const CHAPTER_SCROLL_PREFIX = 'aisu-scroll:';

export function encodeChapterScrollRatio(scrollRatio: number): string {
  // A four-decimal ratio can lose several lines in a very long chapter, or
  // turn a near-boundary position into the beginning/end. Preserve the value
  // that Number() can round-trip while retaining the existing CFI prefix.
  return `${CHAPTER_SCROLL_PREFIX}${clampScrollRatio(scrollRatio)}`;
}

export function decodeChapterScrollRatio(value?: string): number | null {
  if (!value?.startsWith(CHAPTER_SCROLL_PREFIX)) {
    return null;
  }

  const parsedRatio = Number(value.slice(CHAPTER_SCROLL_PREFIX.length));
  if (!Number.isFinite(parsedRatio)) {
    return null;
  }

  return clampScrollRatio(parsedRatio);
}

export function getChapterProgressPercent(
  chapterIndex: number,
  chapterCount: number,
  scrollRatio: number,
  chapterWeights?: ReadonlyArray<number | undefined>,
): number {
  if (chapterCount <= 0) {
    return 0;
  }

  const normalizedChapterIndex = Math.min(Math.max(1, chapterIndex), chapterCount);
  const validWeights = getValidChapterWeights(chapterWeights, chapterCount);
  const rawProgress = validWeights
    ? getWeightedProgress(normalizedChapterIndex, clampScrollRatio(scrollRatio), validWeights)
    : ((normalizedChapterIndex - 1 + clampScrollRatio(scrollRatio)) / chapterCount) * 100;
  // A rounded 0% can still have reading history. Reserve 100% for the end,
  // even when one remaining chapter is tiny.
  if (rawProgress <= 0) return 0;
  if (normalizedChapterIndex === chapterCount && clampScrollRatio(scrollRatio) === 1) return 100;
  return Math.min(99, Math.round(rawProgress));
}

function getValidChapterWeights(chapterWeights: ReadonlyArray<number | undefined> | undefined, chapterCount: number): number[] | null {
  if (chapterWeights?.length !== chapterCount) {
    return null;
  }

  const weights = chapterWeights.filter((weight): weight is number => typeof weight === 'number' && Number.isFinite(weight) && weight > 0);
  return weights.length === chapterCount ? weights : null;
}

function getWeightedProgress(chapterIndex: number, scrollRatio: number, chapterWeights: readonly number[]): number {
  const completedWeight = chapterWeights.slice(0, chapterIndex - 1).reduce((total, weight) => total + weight, 0);
  const currentWeight = chapterWeights[chapterIndex - 1] ?? 0;
  const totalWeight = chapterWeights.reduce((total, weight) => total + weight, 0);
  return ((completedWeight + currentWeight * scrollRatio) / totalWeight) * 100;
}

function clampScrollRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}
