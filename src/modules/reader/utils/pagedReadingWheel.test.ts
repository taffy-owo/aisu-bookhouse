import { describe, expect, it } from 'vitest';
import { createPagedReadingWheel } from './pagedReadingWheel';

const vertical = (deltaY: number, deltaMode = 0) => ({ deltaX: 0, deltaY, deltaMode });

describe('paged wheel gestures', () => {
  it('combines fine movement within one gesture into a single page turn', () => {
    const move = createPagedReadingWheel();
    expect(move(vertical(12), 800, 0)).toBe(0);
    expect(move(vertical(12), 800, 40)).toBe(0);
    expect(move(vertical(12), 800, 80)).toBe(1);
    expect(move(vertical(100), 800, 100)).toBe(0);
  });

  it('does not retain momentum that would swallow a later reverse turn', () => {
    const move = createPagedReadingWheel();
    expect(move(vertical(80), 800, 0)).toBe(1);
    expect(move(vertical(100), 800, 80)).toBe(0);
    expect(move(vertical(-80), 800, 400)).toBe(-1);
  });

  it('starts accumulating afresh when the direction changes', () => {
    const move = createPagedReadingWheel();
    expect(move(vertical(20), 800, 0)).toBe(0);
    expect(move(vertical(-20), 800, 40)).toBe(0);
    expect(move(vertical(-12), 800, 80)).toBe(-1);
  });

  it('does not combine separate small gestures after a pause', () => {
    const move = createPagedReadingWheel();
    expect(move(vertical(20), 800, 0)).toBe(0);
    expect(move(vertical(20), 800, 900)).toBe(0);
    expect(move(vertical(12), 800, 940)).toBe(1);
  });

  it('discards motion during the interval without delaying the next full gesture', () => {
    const move = createPagedReadingWheel();
    expect(move(vertical(80), 800, 0)).toBe(1);
    expect(move(vertical(25), 800, 120)).toBe(0);
    expect(move(vertical(10), 800, 330)).toBe(0);
    expect(move(vertical(20), 800, 370)).toBe(1);
  });

  it('normalizes mouse-wheel lines and page units in both directions', () => {
    const move = createPagedReadingWheel();
    expect(move(vertical(2, 1), 800, 0)).toBe(1);
    expect(move(vertical(-1, 2), 800, 400)).toBe(-1);
  });

  it('uses the dominant axis for horizontal touchpads and diagonal gestures', () => {
    const move = createPagedReadingWheel();
    expect(move({ deltaX: -80, deltaY: 5, deltaMode: 0 }, 800, 0)).toBe(-1);
    expect(move({ deltaX: -5, deltaY: 80, deltaMode: 0 }, 800, 400)).toBe(1);
  });

  it('ignores empty and invalid motion without poisoning the next gesture', () => {
    const move = createPagedReadingWheel();
    expect(move(vertical(Number.NaN), 800, 0)).toBe(0);
    expect(move(vertical(Infinity), 800, 10)).toBe(0);
    expect(move(vertical(0), 800, 20)).toBe(0);
    expect(move(vertical(80), 800, 30)).toBe(1);
  });
});
