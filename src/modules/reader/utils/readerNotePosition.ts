import type { ReaderMarkPositionInput } from '../types/reader';

/** File/chapter identity alone does not identify a page or a point in prose. */
export function isSameReaderNotePosition(left: ReaderMarkPositionInput, right: ReaderMarkPositionInput): boolean {
  if (left.readerType !== right.readerType || left.positionKey !== right.positionKey || left.contentVersion !== right.contentVersion
    || left.chapterIndex !== right.chapterIndex || left.pageNumber !== right.pageNumber
    || left.imageIndex !== right.imageIndex || left.epubCfi !== right.epubCfi) return false;
  // Percentage is only a fallback for older marks without a precise locator.
  return Boolean(left.epubCfi) || left.pageNumber !== undefined || left.imageIndex !== undefined
    || left.progressPercent === right.progressPercent;
}
