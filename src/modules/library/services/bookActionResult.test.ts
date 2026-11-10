import { describe, expect, it } from 'vitest';
import type { Book } from '../../books';
import { applyBookReadingCompletion, mergeBookActionResult, type BookActionKind } from './bookActionResult';

const original: Book = {
  id: 'one', title: '书名', author: '作者', description: '简介', kind: 'novel', readerType: 'epub', tags: [],
  progressPercent: 75, currentChapter: '第2话', favorite: false, disliked: false,
  updatedAt: '2026-10-27T01:00:00Z', createdAt: '2026-10-01',
};

describe('parallel book action snapshots', () => {
  it('clears reading history with the confirmed unread reset', () => {
    const current = { ...original, lastReadAt: original.updatedAt };
    const reset = { ...original, progressPercent: 0, currentChapter: undefined };
    expect(mergeBookActionResult(current, reset, 'reading')).toMatchObject({ progressPercent: 0, currentChapter: undefined, lastReadAt: undefined });
  });
  it.each([['favorite', 'disliked'], ['disliked', 'favorite'], ['reading', 'favorite'], ['favorite', 'reading']] as const)('keeps both %s and %s when responses arrive backwards', (first, second) => {
    const firstSnapshot = { ...original, [first === 'reading' ? 'progressPercent' : first]: first === 'reading' ? 100 : true };
    const secondSnapshot = { ...firstSnapshot, [second === 'reading' ? 'progressPercent' : second]: second === 'reading' ? 100 : true };
    const result = mergeBookActionResult(mergeBookActionResult(original, secondSnapshot, second), firstSnapshot, first);
    expect(result[first === 'reading' ? 'progressPercent' : first]).toBe(first === 'reading' ? 100 : true);
    expect(result[second === 'reading' ? 'progressPercent' : second]).toBe(second === 'reading' ? 100 : true);
  });

  it.each(['cover', 'source', 'public', 'processing', { title: '新书名' }] satisfies BookActionKind[])('preserves separately confirmed shelf flags and reading progress for %j', (action) => {
    const current = { ...original, favorite: true, disliked: true, progressPercent: 100 };
    const result = mergeBookActionResult(current, { ...original, title: '新书名', coverUrl: 'new', status: 'processing', publicStatus: 'pending', sourceUpdateCount: 4 }, action);
    expect(result).toMatchObject({ favorite: true, disliked: true, progressPercent: 100 });
  });

  it('applies server-normalized metadata only for submitted fields', () => {
    const response = { ...original, title: '已整理的书名', author: '旧作者', language: 'zh' as const, languageMode: 'auto' as const, rating: 4 };
    const result = mergeBookActionResult({ ...original, author: '刚修改的作者', rating: 2 }, response, { title: ' 已整理的书名 ', language: 'auto', rating: undefined });
    expect(result).toMatchObject({ title: '已整理的书名', author: '刚修改的作者', language: 'zh', languageMode: 'auto', rating: 2 });
  });

  it('clears source-dependent details after removing the association', () => {
    const current = { ...original, sourceUrl: 'old', sourceUpdateCount: 4, sourceEpisodeCount: 10, sourceScheduleTime: '18:00', autoTranslateUpdates: true };
    const result = mergeBookActionResult(current, { ...original, autoTranslateUpdates: false }, { sourceUrl: null, autoTranslateUpdates: false });
    expect(result).toMatchObject({ sourceUrl: undefined, sourceUpdateCount: undefined, sourceEpisodeCount: undefined, sourceScheduleTime: undefined, autoTranslateUpdates: false });
  });

  it('adopts source count and schedule changes without undoing other metadata', () => {
    const result = mergeBookActionResult({ ...original, title: '刚整理的书名' }, { ...original, publicationStatus: 'completed', sourceUpdateCount: 4, sourceEpisodeCount: 38, sourceScheduleTime: '18:00' }, 'source');
    expect(result).toMatchObject({ title: '刚整理的书名', publicationStatus: 'completed', sourceUpdateCount: 4, sourceEpisodeCount: 38, sourceScheduleTime: '18:00' });
  });

  it('retains the latest book timestamp when older actions finish later', () => {
    expect(mergeBookActionResult({ ...original, updatedAt: '2026-10-27T03:00:00Z' }, original, 'favorite').updatedAt).toBe('2026-10-27T03:00:00Z');
  });
  it.each([
    ['2026-10-27T01:00:00Z', '2026-10-27T01:00:01'],
    ['2026-10-27T01:00:00.123456Z', '2026-10-27T01:00:00.123457Z'],
  ])('keeps the newer action time across timestamp formats and precision', (earlier, later) => {
    const current = { ...original, updatedAt: earlier };
    const response = { ...original, updatedAt: later };
    expect(mergeBookActionResult(current, response, 'favorite').updatedAt).toBe(later);
    expect(mergeBookActionResult(response, current, 'favorite').updatedAt).toBe(later);
  });
  it('adopts newer metadata revisions separately from a fast reading clock', () => {
    const current = { ...original, version: '2026-10-27T01:00:00Z', updatedAt: '2026-10-27T01:02:00Z' };
    const latest = mergeBookActionResult(current, { ...original, favorite: true, version: '2026-10-27T01:00:01Z' }, 'favorite');
    expect(latest).toMatchObject({ version: '2026-10-27T01:00:01Z', updatedAt: current.updatedAt, favorite: true });
    expect(mergeBookActionResult(latest, current, 'reading').version).toBe(latest.version);
  });
  it('keeps the latest metadata revision when actions finish within a millisecond', () => {
    const current = { ...original, version: '2026-10-27T01:00:00.123456Z' };
    const response = { ...original, version: '2026-10-27T01:00:00.123457Z' };
    expect(mergeBookActionResult(current, response, 'favorite').version).toBe(response.version);
    expect(mergeBookActionResult(response, current, 'reading').version).toBe(response.version);
  });

  it('removes a custom cover while keeping newer book details', () => {
    expect(mergeBookActionResult({ ...original, coverUrl: 'custom', title: '新书名' }, original, 'cover'))
      .toMatchObject({ title: '新书名', coverUrl: undefined });
  });

  it('adopts public sharing permissions and clears obsolete moderation fields', () => {
    const current = { ...original, publicStatus: 'rejected' as const, publicRejectedAt: '2026-10-26', publicDownloadAllowed: false };
    const response = { ...original, publicStatus: 'pending' as const, publicShareNote: '推荐理由', publicSourceNote: '来源', publicDownloadAllowed: true, readersLabel: '公共书库审核中' };
    expect(mergeBookActionResult(current, response, 'public')).toMatchObject({ publicStatus: 'pending', publicRejectedAt: undefined, publicShareNote: '推荐理由', publicSourceNote: '来源', publicDownloadAllowed: true, readersLabel: '公共书库审核中' });
  });

  it('applies processing status without restoring the captured old progress', () => {
    expect(mergeBookActionResult({ ...original, progressPercent: 100 }, { ...original, status: 'processing' }, 'processing'))
      .toMatchObject({ status: 'processing', progressPercent: 100 });
  });

  it('does not patch a different book', () => {
    expect(mergeBookActionResult(original, { ...original, id: 'two', favorite: true }, 'favorite')).toBe(original);
  });
});

describe('explicit reading completion', () => {
  const progress = { bookId: original.id, chapterIndex: 2, chapterHref: 'two.xhtml', epubCfi: 'aisu-scroll:0.4', pageNumber: 8, imageIndex: 9, progressPercent: 75, updatedAt: original.updatedAt };

  it('keeps the resume location when marking read', () => {
    expect(applyBookReadingCompletion(progress, original, true)).toMatchObject({ ...progress, progressPercent: 100, updatedAt: expect.any(String) });
  });
  it('clears every saved position when resetting unread', () => {
    const result = applyBookReadingCompletion(progress, original, false);
    expect(result).toMatchObject({ bookId: 'one', progressPercent: 0 });
    for (const key of ['chapterIndex', 'chapterHref', 'epubCfi', 'pageNumber', 'imageIndex']) expect(result).not.toHaveProperty(key);
  });
  it('uses the confirmed server time even if the device clock differs', () => {
    expect(applyBookReadingCompletion(progress, { ...original, updatedAt: '2026-10-29T02:00:00.123456Z' }, false).updatedAt)
      .toBe('2026-10-29T02:00:00.123456Z');
  });
  it('does not transfer a resume location from a previous format', () => {
    const result = applyBookReadingCompletion({ ...progress, readerType: 'pdf' }, original, true);
    expect(result).toMatchObject({ bookId: 'one', readerType: 'epub', progressPercent: 100 });
    for (const key of ['chapterIndex', 'chapterHref', 'epubCfi', 'pageNumber', 'imageIndex']) expect(result).not.toHaveProperty(key);
  });
  it.each([progress, null])('uses the confirmed resume location even while detail progress is stale or absent', (current) => {
    const confirmed = { ...progress, readerType: 'epub' as const, chapterIndex: 3, epubCfi: 'aisu-scroll:0.7', progressPercent: 100, updatedAt: '2026-10-29T02:00:00Z' };
    const result = applyBookReadingCompletion(current, { ...original, progressPercent: 100, readingProgress: confirmed }, true);
    expect(result).toEqual(confirmed);
    expect(result).not.toBe(confirmed);
  });
  it('does not import another book or reader format from an invalid completion snapshot', () => {
    for (const readingProgress of [{ ...progress, readerType: 'pdf' as const }, { ...progress, readerType: 'epub' as const, bookId: 'two' }]) {
      const result = applyBookReadingCompletion(null, { ...original, readingProgress }, true);
      expect(result).toMatchObject({ bookId: 'one', progressPercent: 100, readerType: 'epub' });
      expect(result.chapterIndex).toBeUndefined();
    }
  });
  it.each([null, { ...progress, bookId: 'two' }])('creates a complete record without importing another book position', (current) => {
    const result = applyBookReadingCompletion(current, original, true);
    expect(result).toMatchObject({ bookId: 'one', progressPercent: 100, readerType: 'epub' });
    expect(result.chapterIndex).toBeUndefined();
  });
});
