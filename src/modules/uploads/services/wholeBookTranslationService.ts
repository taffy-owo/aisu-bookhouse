import { apiRequest } from '../../../shared/api';
import { compareAppTimestamps } from '../../../shared/utils/formatDate';

export const TRANSLATION_JOBS_CHANGED_EVENT = 'aisu:translation-jobs-changed';
export const TRANSLATED_BOOKS_CHANGED_EVENT = 'aisu:translated-books-changed';

export type WholeBookTranslationJob = {
  acknowledged: boolean;
  author: string;
  book_id: string | null;
  job_kind: 'whole_book' | 'source_update';
  channel_id: string | null;
  channel_name: string;
  completed_chapters: number;
  created_at: string;
  current_chapter_index: number | null;
  error_message: string | null;
  finished_at: string | null;
  id: string;
  max_concurrency: number;
  message: string | null;
  model: string;
  progress: number;
  quality_issue_count: number;
  quality_status: 'pending' | 'passed' | 'warning';
  quota_resume_at: string | null;
  request_concurrency: number;
  pause_requested: boolean;
  source_provider: string;
  source_episode_urls?: string[];
  source_url: string;
  stage: string;
  status: 'queued' | 'processing' | 'paused' | 'waiting_quota' | 'review' | 'ready' | 'rejected' | 'failed';
  title: string;
  total_chapters: number;
  updated_at: string;
};

export function isSupersededTranslationFailure(job: WholeBookTranslationJob, jobs: readonly WholeBookTranslationJob[]): boolean {
  const required = job.source_episode_urls ?? [];
  return job.status === 'failed' && required.length > 0 && required.length === job.total_chapters && jobs.some((candidate) => (
    candidate.id !== job.id
    && candidate.status === 'ready'
    && candidate.completed_chapters === candidate.total_chapters
    && candidate.source_episode_urls?.length === candidate.total_chapters
    && candidate.job_kind === job.job_kind
    && (job.job_kind === 'whole_book' ? candidate.source_url === job.source_url : Boolean(job.book_id) && candidate.book_id === job.book_id)
    && compareAppTimestamps(candidate.updated_at, job.updated_at) > 0
    && required.every((url) => candidate.source_episode_urls?.includes(url))
  ));
}

export function selectBookTranslationJob(jobs: WholeBookTranslationJob[], bookId: string): WholeBookTranslationJob | null {
  const priority: Record<WholeBookTranslationJob['status'], number> = {
    review: 0,
    processing: 1,
    queued: 2,
    waiting_quota: 3,
    paused: 4,
    failed: 5,
    ready: 6,
    rejected: 7,
  };
  return jobs
    .filter((job) => (
      job.book_id === bookId
      && job.status !== 'rejected'
      && !(job.status === 'ready' && job.acknowledged)
      && !isSupersededTranslationFailure(job, jobs)
    ))
    .sort((left, right) => {
      const statusDifference = priority[left.status] - priority[right.status];
      if (statusDifference !== 0) return statusDifference;
      return compareAppTimestamps(right.updated_at, left.updated_at);
    })[0] ?? null;
}

export function getWholeBookTranslationStatusLabel(job: WholeBookTranslationJob): string {
  return {
    review: '译稿等待审核',
    failed: '翻译失败',
    ready: job.job_kind === 'whole_book' ? '整本翻译已完成' : '更新译文已加入原书',
    paused: '翻译已暂停',
    waiting_quota: '等待额度恢复',
    rejected: '译稿已放弃',
    queued: job.stage === 'packaging' ? '等待验证和发布' : '等待后台翻译',
    processing: job.pause_requested ? '正在暂停' : job.stage === 'packaging' ? '正在验证和发布' : job.job_kind === 'whole_book' ? '正在翻译后续章节' : '正在精翻更新',
  }[job.status];
}

/** Prefer the current attempt's status over a diagnostic retained from an older attempt. */
export function getWholeBookTranslationQualityMessage(job: Pick<WholeBookTranslationJob, 'quality_status' | 'quality_issue_count' | 'completed_chapters' | 'total_chapters'>): string {
  if (job.quality_status === 'warning') return `质量检查 · ${job.quality_issue_count} 项待复核`;
  if (job.quality_status === 'pending') return '质量检查 · 待检查';
  return job.completed_chapters < job.total_chapters
    ? `已完成的 ${job.completed_chapters} 话检查通过；其余待检查`
    : '质量检查 · 已通过';
}

export function getWholeBookTranslationStatusMessage(job: WholeBookTranslationJob): string {
  if (job.status === 'failed' || job.status === 'waiting_quota') {
    const diagnostic = job.error_message || job.message || '';
    if (/provider_rejected|prohibited_content|content_filtered/i.test(diagnostic)) {
      return '当前模型因内容政策拒绝了本次请求，未生成译文；点击重试会自动切换到其他已启用的 Gemini 模型';
    }
    if (/\bHTTP\s*(?:status\s*)?(?:404|410)\b|http_status[=:]\s*(?:404|410)/i.test(diagnostic)) {
      return '当前模型已下线或接口已移除，翻译进度已保留；点击重试会重新选择可用的翻译模型';
    }
    return diagnostic || (job.status === 'failed' ? '翻译失败，请从断点重试' : '额度暂不可用，等待后台自动重试');
  }
  return job.message || job.error_message || '等待后台处理';
}

export type SourceUpdateTranslationReview = {
  book_id: string;
  chapters: Array<{
    content: string;
    index: number;
    source_title: string;
    source_url: string;
    title: string;
  }>;
  job_id: string;
  status: WholeBookTranslationJob['status'];
  title: string;
};

export type TranslationJobNotifications = {
  active_count: number;
  items: WholeBookTranslationJob[];
  unread_count: number;
};

export async function createWholeBookTranslation(sourceUrl: string, customInstructions = '', requestConcurrency = 2, model = '', channelId: string | null = null, signal?: AbortSignal): Promise<WholeBookTranslationJob> {
  const job = await apiRequest<WholeBookTranslationJob>('/translations', {
    body: JSON.stringify({
      source_url: sourceUrl,
      custom_instructions: customInstructions.trim() || null,
      model: model.trim(),
      channel_id: channelId,
      request_concurrency: requestConcurrency,
    }),
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
  announceTranslationJobsChanged();
  return job;
}

export async function getWholeBookTranslationJobs(signal?: AbortSignal): Promise<WholeBookTranslationJob[]> {
  const pageSize = 100;
  const jobs: WholeBookTranslationJob[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await apiRequest<WholeBookTranslationJob[]>(`/translations?offset=${offset}&limit=${pageSize}`, { signal });
    jobs.push(...page);
    if (page.length < pageSize) return jobs;
  }
}

export async function getBookTranslationJobs(bookId: string, signal?: AbortSignal): Promise<WholeBookTranslationJob[]> {
  return apiRequest<WholeBookTranslationJob[]>(`/books/${encodeURIComponent(bookId)}/translation-jobs`, { signal });
}

export async function clearCompletedWholeBookTranslations(signal?: AbortSignal): Promise<number> {
  const response = await apiRequest<{ deleted: number }>('/translations/completed', { method: 'DELETE', ...(signal ? { signal } : {}) });
  announceTranslationJobsChanged();
  return response.deleted;
}

export async function deleteWholeBookTranslation(jobId: string, signal?: AbortSignal): Promise<void> {
  await apiRequest<{ deleted: number }>(`/translations/${encodeURIComponent(jobId)}`, { method: 'DELETE', ...(signal ? { signal } : {}) });
  announceTranslationJobsChanged();
}

export async function getTranslationJobNotifications(signal?: AbortSignal): Promise<TranslationJobNotifications> {
  return apiRequest<TranslationJobNotifications>('/translations/notifications', { signal });
}

export async function retryWholeBookTranslation(jobId: string, signal?: AbortSignal): Promise<WholeBookTranslationJob> {
  const job = await apiRequest<WholeBookTranslationJob>(`/translations/${encodeURIComponent(jobId)}/retry`, { method: 'POST', ...(signal ? { signal } : {}) });
  announceTranslationJobsChanged();
  return job;
}

export async function pauseWholeBookTranslation(jobId: string, signal?: AbortSignal): Promise<WholeBookTranslationJob> {
  const job = await apiRequest<WholeBookTranslationJob>(`/translations/${encodeURIComponent(jobId)}/pause`, { method: 'POST', ...(signal ? { signal } : {}) });
  announceTranslationJobsChanged();
  return job;
}

export async function resumeWholeBookTranslation(jobId: string, signal?: AbortSignal): Promise<WholeBookTranslationJob> {
  const job = await apiRequest<WholeBookTranslationJob>(`/translations/${encodeURIComponent(jobId)}/resume`, { method: 'POST', ...(signal ? { signal } : {}) });
  announceTranslationJobsChanged();
  return job;
}

export async function updateWholeBookTranslationConcurrency(jobId: string, requestConcurrency: number, signal?: AbortSignal): Promise<WholeBookTranslationJob> {
  const job = await apiRequest<WholeBookTranslationJob>(`/translations/${encodeURIComponent(jobId)}/concurrency`, {
    body: JSON.stringify({ request_concurrency: requestConcurrency }),
    method: 'PATCH',
    ...(signal ? { signal } : {}),
  });
  announceTranslationJobsChanged();
  return job;
}

export async function updateWholeBookTranslationModel(jobId: string, model: string, channelId: string | null = null, signal?: AbortSignal): Promise<WholeBookTranslationJob> {
  const job = await apiRequest<WholeBookTranslationJob>(`/translations/${encodeURIComponent(jobId)}/model`, {
    body: JSON.stringify({ model, channel_id: channelId }),
    method: 'PATCH',
    ...(signal ? { signal } : {}),
  });
  announceTranslationJobsChanged();
  return job;
}

export async function acknowledgeWholeBookTranslation(jobId: string, signal?: AbortSignal): Promise<WholeBookTranslationJob> {
  const job = await apiRequest<WholeBookTranslationJob>(`/translations/${encodeURIComponent(jobId)}/acknowledge`, { method: 'POST', ...(signal ? { signal } : {}) });
  announceTranslationJobsChanged();
  return job;
}

export async function getSourceUpdateTranslationReview(jobId: string, signal?: AbortSignal): Promise<SourceUpdateTranslationReview> {
  return apiRequest<SourceUpdateTranslationReview>(`/translations/${encodeURIComponent(jobId)}/review`, { signal });
}

export async function acceptSourceUpdateTranslation(jobId: string, signal?: AbortSignal): Promise<WholeBookTranslationJob> {
  const job = await apiRequest<WholeBookTranslationJob>(`/translations/${encodeURIComponent(jobId)}/accept`, { method: 'POST', ...(signal ? { signal } : {}) });
  announceTranslationJobsChanged();
  return job;
}

export async function rejectSourceUpdateTranslation(jobId: string, signal?: AbortSignal): Promise<WholeBookTranslationJob> {
  const job = await apiRequest<WholeBookTranslationJob>(`/translations/${encodeURIComponent(jobId)}/reject`, { method: 'POST', ...(signal ? { signal } : {}) });
  announceTranslationJobsChanged();
  return job;
}

export function announceTranslationJobsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TRANSLATION_JOBS_CHANGED_EVENT));
}
