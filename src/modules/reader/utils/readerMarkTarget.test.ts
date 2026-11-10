import { describe, expect, it } from 'vitest';
import type { ReaderMark, ReaderResource } from '../types/reader';
import { resolveReaderMarkTarget } from './readerMarkTarget';

const mark: ReaderMark = { id: 'mark', bookId: 'book', readerType: 'epub', kind: 'note',
  label: '旁注', note: '保留的备注', progressPercent: 12, chapterIndex: 999,
  positionKey: 'chapter-b', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const novel: ReaderResource = { readerType: 'epub', chapterCount: 2,
  toc: [{ index: 1, title: '第一话', positionKey: 'chapter-b' }, { index: 2, title: '第二话', positionKey: 'chapter-a' }] };

describe('current mark jump target', () => {
  it('disables a previously loaded mark after the same chapter identity receives a new content version', () => {
    const updated: ReaderResource = { ...novel, toc: novel.toc.map(item => ({ ...item, contentVersion: 'revised' })) };
    expect(resolveReaderMarkTarget({ ...mark, contentVersion: 'previous' }, updated)).toBeNull();
    expect(resolveReaderMarkTarget({ ...mark, contentVersion: 'revised' }, updated)).toEqual({ kind: 'chapter', index: 1, ratio: 0 });
    expect(resolveReaderMarkTarget(mark, updated)).toEqual({ kind: 'chapter', index: 1, ratio: 0 });
  });
  it('follows a surviving identity and ignores its obsolete chapter ordinal', () => {
    expect(resolveReaderMarkTarget({ ...mark, epubCfi: 'aisu-scroll:0.42' }, novel)).toEqual({ kind: 'chapter', index: 1, ratio: .42 });
  });

  it.each([
    { positionKey: 'missing' }, { positionValid: false }, { readerType: 'text' as const },
    { pageNumber: 2 }, { imageIndex: 2 }, { positionKey: undefined },
  ])('cannot jump from stale or mixed chapter coordinates: %j', changes => {
    expect(resolveReaderMarkTarget({ ...mark, ...changes }, novel)).toBeNull();
  });

  it('keeps a valid unkeyed chapter usable without guessing a percentage-only note', () => {
    expect(resolveReaderMarkTarget({ ...mark, positionKey: undefined, chapterIndex: 2 }, novel)).toEqual({ kind: 'chapter', index: 2, ratio: 0 });
    expect(resolveReaderMarkTarget({ ...mark, positionKey: undefined, chapterIndex: undefined }, novel)).toBeNull();
  });

  it.each(['comic', 'image'] as const)('follows current %s page identities and rejects missing pages', readerType => {
    const resource: ReaderResource = { readerType, pageCount: 2, pages: [{ index: 1, positionKey: 'page-b' }, { index: 2, positionKey: 'page-a' }] };
    const pageMark = { ...mark, readerType, chapterIndex: undefined, positionKey: 'page-b', imageIndex: 2, pageNumber: 2 };
    expect(resolveReaderMarkTarget(pageMark, resource)).toEqual({ kind: 'image', index: 1 });
    expect(resolveReaderMarkTarget({ ...pageMark, positionKey: 'missing' }, resource)).toBeNull();
    expect(resolveReaderMarkTarget({ ...pageMark, pageNumber: 1 }, resource)).toBeNull();
    expect(resolveReaderMarkTarget({ ...pageMark, positionKey: undefined, imageIndex: 999, pageNumber: 999 }, resource)).toBeNull();
    expect(resolveReaderMarkTarget({ ...pageMark, positionKey: undefined, imageIndex: undefined, pageNumber: undefined }, resource)).toBeNull();
  });

  it('requires a positive PDF page in the current edition', () => {
    const pdf: ReaderResource = { readerType: 'pdf', positionKey: 'current-pdf', pageCount: 3 };
    const pageMark = { ...mark, readerType: 'pdf' as const, chapterIndex: undefined, positionKey: 'current-pdf', pageNumber: 2 };
    expect(resolveReaderMarkTarget(pageMark, pdf)).toEqual({ kind: 'pdf', pageNumber: 2 });
    for (const changes of [{ positionKey: 'old-pdf' }, { pageNumber: 0 }, { pageNumber: 4 }, { pageNumber: NaN }, { pageNumber: undefined }, { imageIndex: 2 }]) {
      expect(resolveReaderMarkTarget({ ...pageMark, ...changes }, pdf)).toBeNull();
    }
    expect(resolveReaderMarkTarget(pageMark, { ...pdf, pageCount: undefined })).toBeNull();
  });
});
