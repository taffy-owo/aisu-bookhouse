import { describe, expect, it } from 'vitest';
import type { Book } from '../types/book';
import type { WholeBookTranslationJob } from '../../uploads/services/wholeBookTranslationService';
import { reconcileTranslationNotification, removeAcknowledgedSourceUpdate } from './notificationReconciliation';

const source = { id: 'book-a', sourceUpdateCount: 3 } as Book;
const job = (patch: Partial<WholeBookTranslationJob> = {}) => ({ id: 'job-a', status: 'ready', acknowledged: false, ...patch } as WholeBookTranslationJob);

describe('confirmed notification changes', () => {
  it('removes only the confirmed source update and preserves undisplayed totals', () => {
    const state = { bookCount: 50, episodeCount: 110, items: [source] };
    const next = removeAcknowledgedSourceUpdate(state, source.id);
    expect(next).toEqual({ bookCount: 49, episodeCount: 107, items: [] });
    expect(removeAcknowledgedSourceUpdate(next, source.id)).toBe(next);
  });

  it.each(['ready', 'review', 'failed'] as const)('removes unread %s counts on confirmation without losing other jobs', (status) => {
    const other = job({ id: 'job-b', status: 'processing' });
    const state = { active_count: 5, unread_count: 9, items: [job({ status }), other] };
    expect(reconcileTranslationNotification(state, 'job-a', job({ status, acknowledged: true })))
      .toEqual({ active_count: 5, unread_count: 8, items: [other] });
  });

  it('moves a retried failed job from unread to active immediately', () => {
    const state = { active_count: 2, unread_count: 4, items: [job({ status: 'failed' })] };
    const updated = job({ status: 'queued' });
    const next = reconcileTranslationNotification(state, 'job-a', updated);
    expect(next).toEqual({ active_count: 3, unread_count: 3, items: [updated] });
    expect(reconcileTranslationNotification(next, 'job-a', updated)).toEqual(next);
  });

  it('keeps active acknowledged jobs visible and counts only their active state', () => {
    const state = { active_count: 1, unread_count: 0, items: [job({ status: 'waiting_quota' })] };
    const updated = job({ status: 'queued', acknowledged: true });
    expect(reconcileTranslationNotification(state, 'job-a', updated)).toEqual({ active_count: 1, unread_count: 0, items: [updated] });
  });

  it('deletes a reviewed result without leaving an unread badge behind', () => {
    expect(reconcileTranslationNotification({ active_count: 0, unread_count: 1, items: [job({ status: 'review' })] }, 'job-a'))
      .toEqual({ active_count: 0, unread_count: 0, items: [] });
  });
});
