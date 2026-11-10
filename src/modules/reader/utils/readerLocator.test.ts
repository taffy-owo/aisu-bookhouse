import { describe, expect, it } from 'vitest';
import { filterReaderTocItems, normalizeRequestedPageIndex } from './readerLocator';

describe('readerLocator', () => {
  it('rejects unfinished and non-decimal page input instead of interpreting it as another page', () => {
    for (const value of ['', '  ', '1e2', '0x10', '-2', '+3', '2.5', 'Infinity', '999999999999999999']) {
      expect(normalizeRequestedPageIndex(value, 120)).toBeNull();
    }
    expect(normalizeRequestedPageIndex(' １２ ', 120)).toBe(12);
    expect(normalizeRequestedPageIndex('００２', 120)).toBe(2);
    expect(normalizeRequestedPageIndex('2', 0)).toBeNull();
    expect(normalizeRequestedPageIndex('2', NaN)).toBeNull();
  });
  it('filters chapter titles and chapter numbers without being picky about spaces', () => {
    const toc = [
      { index: 1, title: '第一章 早安' },
      { index: 12, title: '第十二章 购物中心' },
      { index: 20, title: '第二十章 归途' },
    ];

    expect(filterReaderTocItems(toc, '购物')).toEqual([{ index: 12, title: '第十二章 购物中心' }]);
    expect(filterReaderTocItems(toc, '第 十二')).toEqual([{ index: 12, title: '第十二章 购物中心' }]);
    expect(filterReaderTocItems(toc, '20')).toEqual([{ index: 20, title: '第二十章 归途' }]);
    expect(filterReaderTocItems(toc, '   ')).toEqual(toc);
  });

  it('accepts full-width phone input and compatible title forms', () => {
    const toc = [{ index: 340, title: '第３４０話 ＡＢＣの続き' }, { index: 12, title: '第十二话 序章' }];
    expect(filterReaderTocItems(toc, ' ３４０ ')).toEqual([toc[0]]);
    expect(filterReaderTocItems(toc, '340')).toEqual([toc[0]]);
    expect(filterReaderTocItems(toc, 'ａｂｃ')).toEqual([toc[0]]);
    expect(filterReaderTocItems(toc, 'ABC')).toEqual([toc[0]]);
  });

  it('normalizes direct page jumps to the valid page range', () => {
    expect(normalizeRequestedPageIndex('8', 20)).toBe(8);
    expect(normalizeRequestedPageIndex('0', 20)).toBe(1);
    expect(normalizeRequestedPageIndex('999', 20)).toBe(20);
    expect(normalizeRequestedPageIndex('2.5', 20)).toBeNull();
    expect(normalizeRequestedPageIndex('abc', 20)).toBeNull();
  });
});
