import { describe, expect, it } from 'vitest';
import { getBookProgressLabel, hasBookReadingHistory } from './bookProgress';

describe('getBookProgressLabel', () => {
  it('distinguishes saved positions below one percent from an unread reset', () => {
    const lastReadAt = '2026-11-05T01:00:00Z';
    expect(hasBookReadingHistory({ progressPercent: 0, lastReadAt })).toBe(true);
    expect(getBookProgressLabel(0, lastReadAt)).toEqual({ label: '阅读 <1%', tone: 'inProgress' });
    expect(hasBookReadingHistory({ progressPercent: 0 })).toBe(false);
    expect(getBookProgressLabel(0)).toEqual({ label: '未读', tone: 'unread' });
  });
  it('uses direct text for unread, in-progress, and finished books', () => {
    expect(getBookProgressLabel(0)).toEqual({ label: '未读', tone: 'unread' });
    expect(getBookProgressLabel(0.4)).toEqual({ label: '阅读 <1%', tone: 'inProgress' });
    expect(getBookProgressLabel(43.4)).toEqual({ label: '阅读 43%', tone: 'inProgress' });
    expect(getBookProgressLabel(100)).toEqual({ label: '已读', tone: 'finished' });
  });

  it('clamps invalid percentages without showing an unfinished 100%', () => {
    expect(getBookProgressLabel(-8)).toEqual({ label: '未读', tone: 'unread' });
    expect(getBookProgressLabel(99.8)).toEqual({ label: '阅读 99%', tone: 'inProgress' });
    expect(getBookProgressLabel(130)).toEqual({ label: '已读', tone: 'finished' });
  });
});
