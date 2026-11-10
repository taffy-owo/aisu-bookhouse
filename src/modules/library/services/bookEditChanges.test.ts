import { describe, expect, it } from 'vitest';
import type { Book } from '../../books';
import { getBookEditChanges } from './bookEditChanges';

const book: Book = { id: 'book', title: '原书名', author: '原作者', description: '原简介', tags: ['本地上传'], kind: 'novel', readerType: 'epub', progressPercent: 0, createdAt: '', updatedAt: '' };

describe('book edit changes', () => {
  it('sends only the edited title so a background description refresh is not overwritten', () => {
    expect(getBookEditChanges({ title: '新书名', author: book.author, description: book.description, tags: book.tags, rating: 0 }, book)).toEqual({ title: '新书名' });
  });
  it('keeps explicit clearing of a rating and series information', () => {
    expect(getBookEditChanges({ rating: 0, seriesTitle: null, seriesOrder: null }, { ...book, rating: 8, seriesTitle: '系列', seriesOrder: 2 }))
      .toEqual({ rating: 0, seriesTitle: null, seriesOrder: null });
  });
  it('saves changed source statistics without sending absent metadata fields', () => {
    expect(getBookEditChanges({ sourceEpisodeCount: 20, sourceCharacterCount: undefined, sourceScheduleTimezone: 'Asia/Tokyo' }, { ...book, sourceEpisodeCount: 19 }))
      .toEqual({ sourceEpisodeCount: 20, sourceScheduleTimezone: 'Asia/Tokyo' });
  });
  it('does not rewrite tags solely because their form representation was normalized', () => {
    expect(getBookEditChanges({ tags: ['本地上传'] }, { ...book, tags: [' 本地上传 ', '本地上传'] })).toEqual({});
  });
  it('keeps automatic recognition when unrelated metadata is edited', () => {
    expect(getBookEditChanges({ title: '新书名', language: 'auto' }, { ...book, language: 'zh', languageMode: 'auto' }))
      .toEqual({ title: '新书名' });
  });
  it('sends a manual choice even when it matches the current detected language', () => {
    expect(getBookEditChanges({ language: 'zh' }, { ...book, language: 'zh', languageMode: 'auto' })).toEqual({ language: 'zh' });
  });
  it('can return to automatic recognition or explicitly leave language unspecified', () => {
    expect(getBookEditChanges({ language: 'auto' }, { ...book, language: 'ja', languageMode: 'manual' })).toEqual({ language: 'auto' });
    expect(getBookEditChanges({ language: 'und' }, { ...book, language: 'und', languageMode: 'auto' })).toEqual({ language: 'und' });
  });
  it('does not silently change legacy known language choices', () => {
    expect(getBookEditChanges({ language: 'zh' }, { ...book, language: 'zh' })).toEqual({});
  });
});
