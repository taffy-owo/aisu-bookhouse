import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../../shared/api', async (original) => ({
  ...await original<typeof import('../../../shared/api')>(),
  apiRequest: vi.fn(), isBackendApiEnabled: () => true,
}));
import { apiRequest } from '../../../shared/api';
import { getReadingProgress, saveReadingProgress } from './readerService';
import { createReadingProgressTimestamp, normalizeProgressTimestamp, observeReadingProgressTimestamp } from './progressTimestamp';
import { observeApiServerTime, resetApiServerClock } from '../../../shared/api/serverClock';
import { clearAuthStorage, setStoredSession } from '../../../shared/api/authTokenStore';

afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); resetApiServerClock(); clearAuthStorage(); });

it('uses a concurrent save response as a boundary for the next action without changing the old retry', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T10:00:00Z'));
  vi.mocked(apiRequest).mockResolvedValueOnce({ book_id: 'concurrent-book', reader_type: 'epub', progress_percent: 80, updated_at: '2026-10-29T10:02:00.123456Z' });
  await saveReadingProgress('concurrent-book', { bookId: 'concurrent-book', readerType: 'epub', progressPercent: 30, updatedAt: '2026-10-29T09:59:00Z' });
  expect(JSON.parse(String(vi.mocked(apiRequest).mock.calls[0][1]?.body)).updated_at).toBe('2026-10-29T09:59:00Z');
  expect(createReadingProgressTimestamp('2026-10-29T09:59:00Z', 'concurrent-book')).toBe('2026-10-29T10:02:00.124Z');
});

it('keeps observed time boundaries scoped to a book and account', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T10:00:00Z'));
  setStoredSession({ id: 'clock-user-a', nickname: 'A', role: 'user' });
  observeReadingProgressTimestamp('clock-scoped-book', '2026-10-29T10:02:00Z');
  observeReadingProgressTimestamp('clock-scoped-book', '2026-10-29T09:00:00Z');
  expect(createReadingProgressTimestamp(undefined, 'clock-scoped-book')).toBe('2026-10-29T10:02:00.001Z');
  expect(createReadingProgressTimestamp(undefined, 'different-book')).toBe('2026-10-29T10:00:00.000Z');
  setStoredSession({ id: 'clock-user-b', nickname: 'B', role: 'user' });
  expect(createReadingProgressTimestamp(undefined, 'clock-scoped-book')).toBe('2026-10-29T10:00:00.000Z');
});

it.each(['read', 'save'])('does not import a late %s response into the next account clock boundary', async (operation) => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T10:00:00Z'));
  const bookId = 'late-clock-' + operation;
  setStoredSession({ id: 'late-clock-user-a', nickname: 'A', role: 'user' });
  let resolve!: (value: unknown) => void;
  vi.mocked(apiRequest).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const request = operation === 'read' ? getReadingProgress(bookId) : saveReadingProgress(bookId, { bookId, readerType: 'epub', progressPercent: 30, updatedAt: '2026-10-29T10:00:00Z' });
  setStoredSession({ id: 'late-clock-user-b', nickname: 'B', role: 'user' });
  resolve({ book_id: bookId, reader_type: 'epub', progress_percent: 80, updated_at: '2026-10-29T10:02:00Z' });
  if (operation === 'save') await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  else await request;
  expect(createReadingProgressTimestamp(undefined, bookId)).toBe('2026-10-29T10:00:00.000Z');
});

it('keeps a new action later than the last observed remote position', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T10:00:00Z'));
  expect(createReadingProgressTimestamp('2026-10-29T10:02:00.123456Z')).toBe('2026-10-29T10:02:00.124Z');
  expect(createReadingProgressTimestamp('invalid')).toBe('2026-10-29T10:00:00.000Z');
});

it('uses API time for new reading actions when the device is an hour ahead', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T11:00:00Z'));
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  observeApiServerTime(new Headers({ Date: 'Thu, 29 Oct 2026 10:00:00 GMT' }), 800);
  expect(createReadingProgressTimestamp('2026-10-29T09:59:00Z')).toBe('2026-10-29T10:00:00.000Z');
});

it('resubmits legacy pending progress as the original UTC instant, including microseconds', async () => {
  await saveReadingProgress('book-a', {
    bookId: 'book-a', readerType: 'epub', progressPercent: 45,
    updatedAt: '2026-07-10T02:00:00.123456',
  });
  const [, options] = vi.mocked(apiRequest).mock.calls[0];
  expect(JSON.parse(String(options?.body)).updated_at).toBe('2026-07-10T02:00:00.123456Z');
});

it('normalizes old server responses before local timestamp comparisons', async () => {
  vi.mocked(apiRequest).mockResolvedValueOnce({ book_id: 'book-a', progress_percent: 45, reader_type: 'epub', updated_at: '2026-07-10T02:00:00' });
  expect((await getReadingProgress('book-a')).updatedAt).toBe('2026-07-10T02:00:00Z');
});

it.each(['2026-07-10T02:00:00Z', '2026-07-10T10:00:00+08:00', '2099-01-01T00:00:00Z', 'invalid'])('does not replace or hide an explicit client timestamp: %s', (value) => {
  expect(normalizeProgressTimestamp(value)).toBe(value);
});
