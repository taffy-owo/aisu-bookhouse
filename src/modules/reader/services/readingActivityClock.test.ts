import { describe, expect, it, vi } from 'vitest';
import { createReadingActivityClock } from './readingActivityClock';

function setup() {
  let at = 0;
  const seconds = vi.fn();
  const clock = createReadingActivityClock((value) => seconds(value), () => at, () => new Date(2026, 9, 28, 12).getTime() + at);
  return { clock, seconds, advance: (ms: number) => { at += ms; } };
}

describe('readable activity clock', () => {
  it('splits one readable interval at local midnight', () => {
    let elapsed = 0;
    const start = new Date(2026, 9, 28, 23, 59, 50).getTime();
    const records: Array<{ seconds: number; day: number }> = [];
    const clock = createReadingActivityClock((seconds, at) => records.push({ seconds, day: at.getDate() }), () => elapsed, () => start + elapsed);
    clock.setActive(true); elapsed = 20_000; clock.flush();
    expect(records).toEqual([{ seconds: 10, day: 28 }, { seconds: 10, day: 29 }]);
    clock.flush(); expect(records).toHaveLength(2);
  });
  it('does not move idle time after midnight into the next day', () => {
    let elapsed = 0;
    const start = new Date(2026, 9, 28, 23, 54).getTime();
    const records: Array<{ seconds: number; day: number }> = [];
    const clock = createReadingActivityClock((seconds, at) => records.push({ seconds, day: at.getDate() }), () => elapsed, () => start + elapsed);
    clock.setActive(true); elapsed = 10 * 60_000; clock.flush();
    expect(records).toEqual([{ seconds: 60, day: 28 }]);
    clock.interact(); elapsed += 2500; clock.flush();
    expect(records[1]).toEqual({ seconds: 2, day: 29 });
  });
  it('does not count a hidden gap spanning midnight', () => {
    let elapsed = 0;
    const start = new Date(2026, 9, 28, 23, 59, 55).getTime();
    const records: Array<{ seconds: number; day: number }> = [];
    const clock = createReadingActivityClock((seconds, at) => records.push({ seconds, day: at.getDate() }), () => elapsed, () => start + elapsed);
    clock.setActive(true); elapsed += 3000; clock.setActive(false);
    elapsed += 60_000; clock.flush(); clock.setActive(true); elapsed += 4000; clock.setActive(false);
    expect(records).toEqual([{ seconds: 3, day: 28 }, { seconds: 4, day: 29 }]);
  });
  it('a wall-clock adjustment cannot create or remove measured reading seconds', () => {
    let elapsed = 0, wall = new Date(2026, 9, 28, 12).getTime();
    const records: number[] = [];
    const clock = createReadingActivityClock((seconds) => records.push(seconds), () => elapsed, () => wall);
    clock.setActive(true); elapsed = 3000; wall += 86_400_000; clock.flush();
    elapsed += 4000; wall -= 172_800_000; clock.flush();
    expect(records).toEqual([3, 4]);
  });
  it('does not count an unavailable reading surface', () => {
    const s = setup(); s.advance(30_000); s.clock.flush(); expect(s.seconds).not.toHaveBeenCalled();
  });
  it('counts readable time and excludes the loading pause between pages', () => {
    const s = setup(); s.clock.setActive(true); s.advance(3400); s.clock.setActive(false);
    s.advance(50_000); s.clock.flush(); s.clock.setActive(true); s.advance(1700); s.clock.setActive(false);
    expect(s.seconds.mock.calls).toEqual([[3], [2]]);
  });
  it('retains fractions through many short readable windows', () => {
    const s = setup();
    for (let i = 0; i < 10; i++) { s.clock.setActive(true); s.advance(400); s.clock.setActive(false); s.advance(2000); }
    expect(s.seconds.mock.calls.flat().reduce((a, b) => a + b, 0)).toBe(4);
  });
  it('retains fractions across periodic flushes', () => {
    const s = setup(); s.clock.setActive(true); s.advance(1300); s.clock.flush(); s.advance(800); s.clock.flush();
    expect(s.seconds.mock.calls).toEqual([[1], [1]]);
  });
  it('does not reset the start on duplicate visible events', () => {
    const s = setup(); s.clock.setActive(true); s.advance(10_000); s.clock.setActive(true); s.clock.flush();
    expect(s.seconds).toHaveBeenCalledWith(10);
  });
  it('does not count hidden time after repeated pause or flush events', () => {
    const s = setup(); s.clock.setActive(true); s.advance(2000); s.clock.setActive(false); s.advance(80_000); s.clock.setActive(false); s.clock.flush();
    expect(s.seconds.mock.calls).toEqual([[2]]);
  });
  it('stops after five minutes without reading interaction', () => {
    const s = setup(); s.clock.setActive(true);
    for (let i = 0; i < 14; i++) { s.advance(30_000); s.clock.flush(); }
    expect(s.seconds.mock.calls.flat().reduce((a, b) => a + b, 0)).toBe(300);
  });
  it('resumes after idle without counting the idle gap', () => {
    const s = setup(); s.clock.setActive(true); s.advance(600_000); s.clock.flush(); s.clock.interact(); s.advance(4000); s.clock.flush();
    expect(s.seconds.mock.calls).toEqual([[60], [4]]);
  });
  it('keeps an active reader alive through interaction', () => {
    const s = setup(); s.clock.setActive(true);
    for (let i = 0; i < 16; i++) { s.advance(30_000); s.clock.interact(); s.clock.flush(); }
    expect(s.seconds.mock.calls.flat().reduce((a, b) => a + b, 0)).toBe(480);
  });
  it('caps an interrupted interval without carrying phantom minutes into later flushes', () => {
    const s = setup(); s.clock.setActive(true); s.advance(120_700); s.clock.flush(); s.clock.flush(); s.advance(500); s.clock.flush();
    expect(s.seconds.mock.calls).toEqual([[60], [1]]);
  });
});
