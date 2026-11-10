import { describe, expect, it } from 'vitest';
import { countTextMatches, estimateReadingMinutes, findTextMatches, formatReadingMinutes } from './readerMetrics';

describe('readerMetrics', () => {
  it('keeps source offsets after characters that expand when lowercased', () => {
    const text = 'İ A A';
    const ranges = findTextMatches(text, 'a');
    expect(ranges).toEqual([{ start: 2, end: 3 }, { start: 4, end: 5 }]);
    expect(ranges.map(({ start, end }) => text.slice(start, end))).toEqual(['A', 'A']);
  });

  it('treats search syntax as literal text', () => {
    for (const query of ['[a+b]?', '.*', '(x)', '\\', '$^', '{2}', '|']) {
      const text = `${query} / ${query}`;
      expect(findTextMatches(text, query).map(({ start, end }) => text.slice(start, end))).toEqual([query, query]);
      expect(countTextMatches(text, query)).toBe(2);
    }
  });

  it('keeps supplementary characters whole', () => {
    expect(findTextMatches('甲🌸乙🌸', '🌸')).toEqual([{ start: 1, end: 3 }, { start: 4, end: 6 }]);
  });

  it('uses Unicode case matching without depending on the browser locale', () => {
    expect(countTextMatches('Σ σ ς', 'σ')).toBe(3);
    expect(countTextMatches('Moon MOON moon', 'moon')).toBe(3);
  });

  it('returns non-overlapping ranges and ignores empty queries', () => {
    expect(findTextMatches('aaaa', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    expect(findTextMatches('正文', '  ')).toEqual([]);
  });

  it('counts case-insensitive non-overlapping text matches', () => {
    expect(countTextMatches('Moon light, moon shadow', 'moon')).toBe(2);
    expect(countTextMatches('aaaa', 'aa')).toBe(2);
    expect(countTextMatches('quiet page', '')).toBe(0);
  });

  it('estimates reading minutes from visible characters', () => {
    expect(estimateReadingMinutes('')).toBe(0);
    expect(estimateReadingMinutes('短句')).toBe(1);
    expect(estimateReadingMinutes('字'.repeat(1001), 500)).toBe(3);
  });

  it('formats reading minutes compactly', () => {
    expect(formatReadingMinutes(0)).toBe('不足 1 分钟');
    expect(formatReadingMinutes(12)).toBe('约 12 分钟');
    expect(formatReadingMinutes(60)).toBe('约 1 小时');
    expect(formatReadingMinutes(75)).toBe('约 1 小时 15 分钟');
  });
});
