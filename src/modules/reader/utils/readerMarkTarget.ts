import type { ReaderMark, ReaderResource } from '../types/reader';
import { decodeChapterScrollRatio } from './chapterScrollPosition';

type ReaderMarkTarget = { kind: 'chapter'; index: number; ratio: number }
  | { kind: 'image'; index: number } | { kind: 'pdf'; pageNumber: number };

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

/** Resolve against current identities before enabling or performing a jump. */
export function resolveReaderMarkTarget(mark: ReaderMark, resource: ReaderResource | null): ReaderMarkTarget | null {
  if (!resource || mark.positionValid === false || mark.readerType !== resource.readerType) return null;
  if (resource.readerType === 'epub' || resource.readerType === 'text') {
    if (mark.imageIndex !== undefined || mark.pageNumber !== undefined) return null;
    const chapter = mark.positionKey ? resource.toc.find(item => item.positionKey === mark.positionKey)
      : resource.toc.find(item => item.index === mark.chapterIndex);
    if (mark.contentVersion && chapter?.contentVersion && mark.contentVersion !== chapter.contentVersion) return null;
    return chapter && positiveInteger(chapter.index) && chapter.index <= resource.chapterCount
      ? { kind: 'chapter', index: chapter.index, ratio: decodeChapterScrollRatio(mark.epubCfi) ?? 0 } : null;
  }
  if (resource.readerType === 'comic' || resource.readerType === 'image') {
    if (mark.chapterIndex !== undefined || (mark.imageIndex !== undefined && mark.pageNumber !== undefined && mark.imageIndex !== mark.pageNumber)) return null;
    const page = mark.positionKey ? resource.pages.find(item => item.positionKey === mark.positionKey)
      : resource.pages.find(item => item.index === (mark.imageIndex ?? mark.pageNumber));
    return page && positiveInteger(page.index) && page.index <= resource.pageCount
      ? { kind: 'image', index: page.index } : null;
  }
  if (resource.readerType === 'pdf' && positiveInteger(resource.pageCount)
    && positiveInteger(mark.pageNumber) && mark.pageNumber <= resource.pageCount
    && mark.chapterIndex === undefined && mark.imageIndex === undefined
    && (!mark.positionKey || mark.positionKey === resource.positionKey)) {
    return { kind: 'pdf', pageNumber: mark.pageNumber };
  }
  return null;
}
