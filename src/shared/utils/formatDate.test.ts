import { describe, expect, it } from 'vitest';
import { compareAppTimestamps, parseAppDate } from './formatDate';

describe('parseAppDate', () => {
  it('treats backend ISO timestamps without a timezone as UTC', () => {
    expect(parseAppDate('2026-05-26T08:14:09.809333').toISOString()).toBe('2026-05-26T08:14:09.809Z');
  });

  it('keeps explicit timezone timestamps unchanged', () => {
    expect(parseAppDate('2026-05-26T08:14:09.809Z').toISOString()).toBe('2026-05-26T08:14:09.809Z');
  });
});

describe('compareAppTimestamps', () => {
  it.each([
    ['2026-10-29T01:00:00.123456', '2026-10-29T09:00:00.123456+08:00'],
    ['2026-10-29T01:00:00Z', '2026-10-29T01:00:00.000000Z'],
    ['2026-10-29T01:00:00.12345Z', '2026-10-29T01:00:00.123450Z'],
  ])('recognizes equivalent timestamps %s and %s', (first, second) => {
    expect(compareAppTimestamps(first, second)).toBe(0);
  });
  it.each([
    ['2026-10-29T01:00:00.123456Z', '2026-10-29T01:00:00.123457Z'],
    ['2026-10-29T01:00:00.123999Z', '2026-10-29T01:00:00.124000Z'],
    ['2026-10-29T01:00:00Z', '2026-10-29T01:00:00.000001Z'],
  ])('preserves timestamp order below a millisecond', (earlier, later) => {
    expect(compareAppTimestamps(earlier, later)).toBeLessThan(0);
    expect(compareAppTimestamps(later, earlier)).toBeGreaterThan(0);
  });
  it('does not order invalid timestamps', () => {
    expect(compareAppTimestamps('', '2026-10-29T01:00:00Z')).toBeNaN();
    expect(compareAppTimestamps('2026-10-29T01:00:00Z', 'invalid')).toBeNaN();
  });
});
