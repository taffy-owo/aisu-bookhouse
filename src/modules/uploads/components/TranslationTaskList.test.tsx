import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { TranslationTaskList } from './TranslationTaskList';
import type { WholeBookTranslationJob } from '../services/wholeBookTranslationService';

function job(overrides: Partial<WholeBookTranslationJob>): WholeBookTranslationJob {
  return {
    id: 'failed', job_kind: 'whole_book', book_id: null,
    source_url: 'https://kakuyomu.jp/works/123', title: '作品', author: '作者',
    status: 'failed', stage: 'context', updated_at: '2026-11-01T00:00:00Z',
    created_at: '2026-11-01T00:00:00Z', completed_chapters: 0, total_chapters: 10,
    progress: 0, message: '渠道请求失败', error_message: null,
    model: 'model', channel_id: null, channel_name: '', request_concurrency: 1,
    max_concurrency: 1, pause_requested: false, acknowledged: false,
    current_chapter_index: null, finished_at: null, quality_status: 'pending',
    quality_issue_count: 0, quota_resume_at: null, source_provider: 'kakuyomu',
    source_episode_urls: Array.from({ length: 10 }, (_, index) => `https://kakuyomu.jp/works/123/episodes/${index + 1}`),
    ...overrides,
  };
}

function render(jobs: WholeBookTranslationJob[]) {
  const action = () => {};
  return renderToStaticMarkup(
    <MemoryRouter>
      <TranslationTaskList jobs={jobs} busyJobIds={new Set()} actionErrors={{}}
        onConcurrencyChange={action} onDelete={action} onModelChange={action}
        onPause={action} onResume={action} onRetry={action} />
    </MemoryRouter>,
  );
}

it('retires a failed whole-book attempt when a later attempt publishes the same source', () => {
  const markup = render([
    job({ id: 'ready', book_id: 'new-book', status: 'ready', completed_chapters: 10,
      updated_at: '2026-11-02T00:00:00Z' }),
    job({}),
  ]);
  expect(markup).toContain('历史失败记录');
  expect(markup).toContain('对应章节已由后续任务发布');
  expect(markup).not.toContain('data-task-focus-control="retry"');
  expect(markup).not.toContain('<select');
});

it('keeps a failed update actionable after the whole book was published', () => {
  const markup = render([
    job({ id: 'ready', book_id: 'book', status: 'ready',
      updated_at: '2026-11-02T00:00:00Z' }),
    job({ job_kind: 'source_update', book_id: 'book' }),
  ]);
  expect(markup).not.toContain('历史失败记录');
  expect(markup).toContain('data-task-focus-control="retry"');
});

it('does not retire an update when a different source chapter was published', () => {
  const markup = render([
    job({ id: 'ready', job_kind: 'source_update', book_id: 'book', status: 'ready',
      completed_chapters: 1, total_chapters: 1, source_episode_urls: ['https://kakuyomu.jp/works/123/episodes/11'],
      updated_at: '2026-11-02T00:00:00Z' }),
    job({ job_kind: 'source_update', book_id: 'book' }),
  ]);
  expect(markup).not.toContain('历史失败记录');
  expect(markup).toContain('data-task-focus-control="retry"');
});
