import { describe, expect, it } from 'vitest';
import type { Book } from '../../books';
import { getBookSeriesInfo, getBookSeriesShelf, groupBooksForLibraryShelf } from './bookSeries';

const baseBook: Book = {
  author: '测试作者',
  createdAt: '2026-05-20T00:00:00.000Z',
  description: '测试图书',
  id: 'book-1',
  kind: 'novel',
  progressPercent: 0,
  readerType: 'epub',
  status: 'ready',
  tags: [],
  title: '测试图书',
  updatedAt: '2026-05-20T00:00:00.000Z',
};

describe('book series helpers', () => {
  it('infers numeric and Chinese volume names', () => {
    expect(getBookSeriesInfo({ ...baseBook, title: '雨夜之月 - 卷01' })).toMatchObject({
      key: '雨夜之月',
      label: '雨夜之月',
      order: 1,
      orderLabel: '第 1 卷',
    });

    expect(getBookSeriesInfo({ ...baseBook, title: '安达与岛村 第十二卷' })).toMatchObject({
      key: '安达与岛村',
      label: '安达与岛村',
      order: 12,
      orderLabel: '第 12 卷',
    });
  });

  it('sorts a same-series shelf and exposes neighbors', () => {
    const books = [
      { ...baseBook, id: 'v2', title: '安达与岛村 第二卷' },
      { ...baseBook, id: 'v1', title: '安达与岛村 第一卷' },
      { ...baseBook, id: 'other', title: '别的书 第一卷' },
      { ...baseBook, id: 'v3', title: '安达与岛村 第三卷' },
    ];

    const shelf = getBookSeriesShelf(books[1]!, books);

    expect(shelf?.label).toBe('安达与岛村');
    expect(shelf?.books.map((book) => book.id)).toEqual(['v1', 'v2', 'v3']);
    expect(shelf?.previousBook).toBeNull();
    expect(shelf?.nextBook?.id).toBe('v2');
  });

  it('uses manual series fields before title inference', () => {
    const manualBook = {
      ...baseBook,
      seriesKind: '外传',
      seriesOrder: 2,
      seriesTitle: '手动系列',
      title: '完全不规则的标题',
    };

    expect(getBookSeriesInfo(manualBook)).toMatchObject({
      key: '手动系列',
      label: '手动系列',
      order: 2,
      orderLabel: '外传 · 第 2 卷',
      source: 'manual',
    });
  });

  it('groups manually assigned books even when their titles do not match', () => {
    const books = [
      { ...baseBook, id: 'side', seriesKind: 'SS', seriesOrder: 99.9, seriesTitle: '手动系列', title: '番外篇' },
      { ...baseBook, id: 'v1', seriesOrder: 1, seriesTitle: '手动系列', title: '第一本' },
      { ...baseBook, id: 'other', title: '别的系列 第一卷' },
    ];

    const shelf = getBookSeriesShelf(books[0]!, books);

    expect(shelf?.books.map((book) => book.id)).toEqual(['v1', 'side']);
    expect(shelf?.books[1]?.seriesInfo.orderLabel).toBe('SS · 第 99.9 卷');
  });

  it('keeps explicitly assigned series together across inconsistent author metadata', () => {
    const items = groupBooksForLibraryShelf([
      { ...baseBook, author: '丸山くがね', id: 'v1', seriesOrder: 1, seriesTitle: 'Overlord', title: 'Overlord 01' },
      { ...baseBook, author: '译者署名', id: 'v14', seriesOrder: 14, seriesTitle: 'Overlord', title: 'OVERLORD14' },
      { ...baseBook, author: '丸山黄金（丸山くがね）', id: 'v15', seriesOrder: 15, seriesTitle: 'Overlord', title: 'OVERLORD第15卷' },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'series' ? items[0].books.map((book) => book.id) : []).toEqual(['v1', 'v14', 'v15']);
    if (items[0]?.kind === 'series') {
      expect(getBookSeriesShelf(items[0].books[0]!, items[0].books)?.books.map((book) => book.id)).toEqual(['v1', 'v14', 'v15']);
    }
  });

  it('keeps inferred series by different authors separate in detail navigation', () => {
    const books = [
      { ...baseBook, id: 'a1', author: '作者甲', title: '同名系列 第一卷' },
      { ...baseBook, id: 'b2', author: '作者乙', title: '同名系列 第二卷' },
      { ...baseBook, id: 'a3', author: '作者甲', title: '同名系列 第三卷' },
    ];
    const shelf = getBookSeriesShelf(books[0]!, books);
    expect(shelf?.books.map((book) => book.id)).toEqual(['a1', 'a3']);
    expect(shelf?.nextBook?.id).toBe('a3');
    expect(getBookSeriesShelf(books[1]!, books)).toBeNull();
  });

  it('does not present duplicate editions of a standalone book as volumes', () => {
    expect(getBookSeriesShelf(baseBook, [baseBook, { ...baseBook, id: 'another-edition' }])).toBeNull();
  });

  it('returns null for a single book', () => {
    expect(getBookSeriesShelf(baseBook, [baseBook])).toBeNull();
  });

  it('folds title-inferred volumes into one library shelf item', () => {
    const items = groupBooksForLibraryShelf([
      { ...baseBook, id: 'v3', title: '明日同學的水手服 第三卷' },
      { ...baseBook, id: 'single', title: '短篇小说' },
      { ...baseBook, id: 'v1', title: '明日同學的水手服 第一卷' },
      { ...baseBook, id: 'v2', title: '明日同學的水手服 第二卷' },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'series', label: '明日同學的水手服' });
    expect(items[0]?.kind === 'series' ? items[0].books.map((book) => book.id) : []).toEqual(['v1', 'v2', 'v3']);
    expect(items[1]).toMatchObject({ kind: 'book', book: { id: 'single' } });
  });

  it('does not fold a lone volume or same-name books by different authors', () => {
    const items = groupBooksForLibraryShelf([
      { ...baseBook, author: '作者甲', id: 'a1', title: '同名系列 第一卷' },
      { ...baseBook, author: '作者乙', id: 'b2', title: '同名系列 第二卷' },
      { ...baseBook, id: 'lone', title: '只有一册 第一卷' },
    ]);

    expect(items.map((item) => item.kind)).toEqual(['book', 'book', 'book']);
  });
});
