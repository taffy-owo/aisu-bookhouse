import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../../shared/api';
import { isSupersededTranslationFailure, selectBookTranslationJob } from './wholeBookTranslationService';
import { createWholeBookTranslation, deleteWholeBookTranslation, getBookTranslationJobs, getSourceUpdateTranslationReview, getWholeBookTranslationJobs, getWholeBookTranslationStatusMessage, pauseWholeBookTranslation, resumeWholeBookTranslation, updateWholeBookTranslationConcurrency, updateWholeBookTranslationModel, type WholeBookTranslationJob } from './wholeBookTranslationService';

vi.mock('../../../shared/api', () => ({ apiRequest: vi.fn() }));

describe('book translation status selection', () => {
  const failed = {
    id: 'old-failed', book_id: 'book', job_kind: 'source_update',
    source_url: 'https://kakuyomu.jp/works/123', status: 'failed',
    total_chapters: 2, completed_chapters: 0,
    source_episode_urls: ['https://kakuyomu.jp/works/123/episodes/1', 'https://kakuyomu.jp/works/123/episodes/2'],
    acknowledged: false, updated_at: '2026-11-01T00:00:00Z',
  } as WholeBookTranslationJob;
  const review = { ...failed, id: 'new-draft', status: 'review', completed_chapters: 2, updated_at: '2026-11-02T00:00:00Z' } as WholeBookTranslationJob;

  it('does not revive an older failure when a reviewed draft is published or acknowledged', () => {
    expect(selectBookTranslationJob([review, failed], 'book')).toBe(review);
    const ready = { ...review, status: 'ready' } as WholeBookTranslationJob;
    expect(selectBookTranslationJob([ready, failed], 'book')).toBe(ready);
    expect(selectBookTranslationJob([{ ...ready, acknowledged: true }, failed], 'book')).toBeNull();
  });

  it('keeps a failed update actionable when only a whole-book attempt succeeded', () => {
    const ready = { ...review, job_kind: 'whole_book', status: 'ready' } as WholeBookTranslationJob;
    expect(selectBookTranslationJob([ready, failed], 'book')).toBe(failed);
    expect(isSupersededTranslationFailure(failed, [ready, failed])).toBe(false);
  });

  it('keeps a new failure and an active task visible after an older success', () => {
    const ready = { ...review, status: 'ready' } as WholeBookTranslationJob;
    const newerFailure = { ...failed, updated_at: '2026-11-03T00:00:00Z' };
    expect(selectBookTranslationJob([ready, newerFailure], 'book')).toBe(newerFailure);
    const paused = { ...newerFailure, id: 'paused', status: 'paused' } as WholeBookTranslationJob;
    expect(selectBookTranslationJob([ready, failed, paused], 'book')).toBe(paused);
  });

  it('matches whole-book attempts across book binding and preserves other work', () => {
    const whole = { ...failed, book_id: null, job_kind: 'whole_book' } as WholeBookTranslationJob;
    const ready = { ...review, status: 'ready', job_kind: 'whole_book' } as WholeBookTranslationJob;
    expect(isSupersededTranslationFailure(whole, [whole, ready])).toBe(true);
    expect(isSupersededTranslationFailure(whole, [whole, { ...ready, source_url: 'https://kakuyomu.jp/works/456' }])).toBe(false);
    expect(isSupersededTranslationFailure(failed, [failed, { ...review, book_id: 'other-book' }])).toBe(false);
  });

  it('requires every failed source chapter to have been published', () => {
    const ready = { ...review, status: 'ready' } as WholeBookTranslationJob;
    const otherChapter = { ...ready, total_chapters: 1, completed_chapters: 1, source_episode_urls: ['https://kakuyomu.jp/works/123/episodes/3'] };
    const partial = { ...otherChapter, source_episode_urls: [failed.source_episode_urls![0]] };
    expect(isSupersededTranslationFailure(failed, [ready])).toBe(true);
    expect(isSupersededTranslationFailure(failed, [otherChapter])).toBe(false);
    expect(isSupersededTranslationFailure(failed, [partial])).toBe(false);
    expect(selectBookTranslationJob([{ ...ready, acknowledged: true }, { ...failed, source_episode_urls: [otherChapter.source_episode_urls[0]], total_chapters: 1 }], 'book')?.id).toBe(failed.id);
  });

  it('preserves failures when the newer draft is unpublished or lacks chapter evidence', () => {
    const ready = { ...review, status: 'ready' } as WholeBookTranslationJob;
    expect(isSupersededTranslationFailure(failed, [review])).toBe(false);
    expect(isSupersededTranslationFailure(failed, [{ ...ready, completed_chapters: 1 }])).toBe(false);
    expect(isSupersededTranslationFailure(failed, [{ ...ready, source_episode_urls: [] }])).toBe(false);
    expect(isSupersededTranslationFailure({ ...failed, source_episode_urls: [] }, [ready])).toBe(false);
  });
});

describe('wholeBookTranslationService', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('includes older records and pending drafts beyond the first 100 jobs', async () => {
    const signal = new AbortController().signal;
    const jobs = Array.from({ length: 118 }, (_, index) => ({ id: `job-${index}`, status: index === 117 ? 'review' : 'ready' } as WholeBookTranslationJob));
    vi.mocked(apiRequest)
      .mockResolvedValueOnce(jobs.slice(0, 100))
      .mockResolvedValueOnce(jobs.slice(100));

    expect(await getWholeBookTranslationJobs(signal)).toEqual(jobs);
    expect(apiRequest).toHaveBeenNthCalledWith(1, '/translations?offset=0&limit=100', { signal });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/translations?offset=100&limit=100', { signal });
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('sends the selected request concurrency with the task snapshot', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ id: 'job-1' });

    await createWholeBookTranslation(' https://example.com/work ', ' 保持角色口吻。 ', 4, 'literary-model');

    expect(apiRequest).toHaveBeenCalledWith('/translations', {
      body: JSON.stringify({
        source_url: ' https://example.com/work ',
        custom_instructions: '保持角色口吻。',
        model: 'literary-model',
        channel_id: null,
        request_concurrency: 4,
      }),
      method: 'POST',
    });
  });

  it('sends the channel a per-book model was picked from', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ id: 'job-2' });

    await createWholeBookTranslation('https://example.com/work-2', '', 2, 'grok-4.6', 'channel-1');

    expect(apiRequest).toHaveBeenCalledWith('/translations', {
      body: JSON.stringify({
        source_url: 'https://example.com/work-2',
        custom_instructions: null,
        model: 'grok-4.6',
        channel_id: 'channel-1',
        request_concurrency: 2,
      }),
      method: 'POST',
    });
  });

  it('re-points a stopped task at another channel', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ id: 'job-3' });

    await updateWholeBookTranslationModel('job-3', 'grok-4.6', 'channel-2');

    expect(apiRequest).toHaveBeenCalledWith('/translations/job-3/model', {
      body: JSON.stringify({ model: 'grok-4.6', channel_id: 'channel-2' }),
      method: 'PATCH',
    });
  });

  it('loads translation jobs for the current book and cancels review reads', async () => {
    const signal = new AbortController().signal;
    vi.mocked(apiRequest).mockResolvedValue([]);

    await getBookTranslationJobs('book/1', signal);
    await getSourceUpdateTranslationReview('job/1', signal);

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/books/book%2F1/translation-jobs', { signal });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/translations/job%2F1/review', { signal });
  });

  it('controls a running translation task', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ id: 'job-1' });

    await pauseWholeBookTranslation('job-1');
    await resumeWholeBookTranslation('job-1');
    await updateWholeBookTranslationConcurrency('job-1', 4);

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/translations/job-1/pause', { method: 'POST' });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/translations/job-1/resume', { method: 'POST' });
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/translations/job-1/concurrency', {
      body: JSON.stringify({ request_concurrency: 4 }),
      method: 'PATCH',
    });
  });

  it('deletes one finished translation record', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ deleted: 1 });

    await deleteWholeBookTranslation('job/1');

    expect(apiRequest).toHaveBeenCalledWith('/translations/job%2F1', { method: 'DELETE' });
  });

  it('explains retired model errors without exposing raw gateway diagnostics', () => {
    const message = getWholeBookTranslationStatusMessage({
      status: 'failed',
      error_message: '本阶段验证失败 [http_error] · HTTP 410',
      message: null,
    } as Parameters<typeof getWholeBookTranslationStatusMessage>[0]);
    expect(message).toContain('模型已下线');
    expect(message).toContain('重新选择可用的翻译模型');
    expect(message).not.toContain('Gemini');
  });

  it('explains that policy refusals retry on another Gemini lane', () => {
    expect(getWholeBookTranslationStatusMessage({
      status: 'failed',
      error_message: '模型因内容政策拒绝了本次请求 [provider_rejected]',
      message: null,
    } as Parameters<typeof getWholeBookTranslationStatusMessage>[0])).toContain('自动切换到其他已启用的 Gemini 模型');
  });

  it('recognizes the worker content-filter diagnostic as a policy refusal', () => {
    expect(getWholeBookTranslationStatusMessage({ status: 'failed', error_message: '[content_filtered]', message: null } as Parameters<typeof getWholeBookTranslationStatusMessage>[0])).toContain('内容政策拒绝');
  });

  it.each([
    ['failed', '翻译失败，请从断点重试'],
    ['waiting_quota', '额度暂不可用，等待后台自动重试'],
  ] as const)('keeps an empty %s diagnostic distinct from a running task', (status, expected) => {
    expect(getWholeBookTranslationStatusMessage({ status, error_message: null, message: null } as Parameters<typeof getWholeBookTranslationStatusMessage>[0])).toBe(expected);
  });
});
