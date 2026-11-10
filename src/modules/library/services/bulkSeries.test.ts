import { describe, expect, it } from 'vitest';
import { inferSeriesOrder, parseBulkSeriesOrder } from './bulkSeries';

describe('bulk series helpers', () => {
  it.each([
    ['Overlord 01 不死者之王', 1],
    ['OVERLORD14 滅國的魔女', 14],
    ['OVERLORD第15卷《半森精灵的神人｜上》', 15],
    ['[夢想成為魔法少女]卷09话41-45', 9],
    ['憧憬成为魔法少女_第51-62.5话', 51],
    ['心上人的妹妹２', 2],
    ['Overlord Prologue', 0],
    ['不可逆性加虐～番外篇～', 900],
  ])('infers an editable order for %s', (title, expected) => {
    expect(inferSeriesOrder(title)).toBe(expected);
  });

  it('keeps unknown titles blank and parses optional manual values', () => {
    expect(inferSeriesOrder('完全不规则的标题')).toBeNull();
    expect(parseBulkSeriesOrder(' 99.9 ')).toBe(99.9);
    expect(parseBulkSeriesOrder('')).toBeNull();
    expect(parseBulkSeriesOrder('not-a-number')).toBeNull();
  });
});
