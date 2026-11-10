import { describe, expect, it } from 'vitest';
import type { Book } from '../../books';
import { buildHomeReadingStats } from './homeStats';

function makeBook(progressPercent: number): Book {
  return {
    author: '测试作者',
    createdAt: '2026-05-20',
    description: '测试图书',
    id: `book-${progressPercent}`,
    kind: 'novel',
    progressPercent,
    readerType: 'epub',
    tags: [],
    title: `测试图书 ${progressPercent}`,
    updatedAt: '2026-05-20',
  };
}

describe('homeStats', () => {
  it('counts saved zero-percent positions as reading, without counting unread resets', () => {
    expect(buildHomeReadingStats([{ ...makeBook(0), lastReadAt: '2026-11-05T01:00:00Z' }, makeBook(0)]))
      .toEqual({ finishedBooks: 0, inProgressBooks: 1, totalBooks: 2 });
  });
  it('builds reading stats from real book progress', () => {
    const stats = buildHomeReadingStats([makeBook(0), makeBook(42), makeBook(100), makeBook(120)]);

    expect(stats).toEqual({
      finishedBooks: 2,
      inProgressBooks: 1,
      totalBooks: 4,
    });
  });

  it('returns zero stats for an empty shelf', () => {
    expect(buildHomeReadingStats([])).toEqual({
      finishedBooks: 0,
      inProgressBooks: 0,
      totalBooks: 0,
    });
  });
});
