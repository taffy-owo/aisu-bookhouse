import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, BookOpen, Check, ChevronDown, ChevronUp, CircleMinus, Clock, LoaderCircle, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getBookDetailPath } from '../../../config/routes';
import { cn } from '../../../shared/utils/cn';
import { parseAppDate } from '../../../shared/utils/formatDate';
import type { TranslationModelOption } from '../../settings/services/aiChannelService';
import { getWholeBookTranslationStatusLabel, getWholeBookTranslationStatusMessage, getWholeBookTranslationQualityMessage, isSupersededTranslationFailure, type WholeBookTranslationJob } from '../services/wholeBookTranslationService';
import { TaskErrorMessage } from './TaskErrorMessage';

// A stopped job may be re-pointed at another lane; a running one holds its lane
// in memory for the chapter it is mid-way through.
const MODEL_CHANGE_STATUSES = ['paused', 'failed', 'waiting_quota', 'queued'];
const COLLAPSED_HISTORY_COUNT = 8;
const CURRENT_STATUSES = ['queued', 'processing', 'waiting_quota', 'paused', 'review', 'failed'];

export function TranslationTaskList({ actionErrors, busyJobIds, disabled = false, jobs, modelOptions = [], onConcurrencyChange, onDelete, onModelChange, onPause, onResume, onRetry }: {
  actionErrors: Readonly<Record<string, string>>;
  busyJobIds: ReadonlySet<string>;
  disabled?: boolean;
  jobs: WholeBookTranslationJob[];
  modelOptions?: TranslationModelOption[];
  onConcurrencyChange: (jobId: string, value: number) => void;
  onDelete: (job: WholeBookTranslationJob) => void;
  onModelChange: (jobId: string, model: string, channelId: string | null) => void;
  onPause: (jobId: string) => void;
  onResume: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}) {
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const supersededJobIds = useMemo(() => {
    return new Set(
      jobs
        .filter((job) => isSupersededTranslationFailure(job, jobs))
        .map((job) => job.id),
    );
  }, [jobs]);

  const currentJobs = useMemo(
    () => jobs.filter((job) => CURRENT_STATUSES.includes(job.status) && !supersededJobIds.has(job.id)),
    [jobs, supersededJobIds],
  );
  const historyJobs = useMemo(
    () => jobs.filter((job) => !CURRENT_STATUSES.includes(job.status) || supersededJobIds.has(job.id)),
    [jobs, supersededJobIds],
  );
  const visibleHistoryJobs = isHistoryExpanded ? historyJobs : historyJobs.slice(0, COLLAPSED_HISTORY_COUNT);

  useEffect(() => {
    if (historyJobs.length <= COLLAPSED_HISTORY_COUNT) {
      setIsHistoryExpanded(false);
    }
  }, [historyJobs.length]);

  if (!jobs.length) return null;

  return (
    <section className="mb-5 border-b border-stone-200 pb-5 dark:border-white/10">
      <h3 className="text-xs font-semibold text-stone-500 dark:text-stone-400">AI 翻译</h3>
      <div className="mt-2 divide-y divide-stone-100 dark:divide-white/[0.07]">
        {currentJobs.map((job) => (
          <TranslationTaskRow
            actionError={actionErrors[job.id]}
            isBusy={disabled || busyJobIds.has(job.id)}
            job={job}
            key={job.id}
            modelOptions={modelOptions}
            isSuperseded={supersededJobIds.has(job.id)}
            onConcurrencyChange={onConcurrencyChange}
            onDelete={onDelete}
            onModelChange={onModelChange}
            onPause={onPause}
            onResume={onResume}
            onRetry={onRetry}
          />
        ))}
        {visibleHistoryJobs.map((job) => (
          <TranslationTaskRow
            actionError={actionErrors[job.id]}
            isBusy={disabled || busyJobIds.has(job.id)}
            job={job}
            key={job.id}
            modelOptions={modelOptions}
            isSuperseded={supersededJobIds.has(job.id)}
            onConcurrencyChange={onConcurrencyChange}
            onDelete={onDelete}
            onModelChange={onModelChange}
            onPause={onPause}
            onResume={onResume}
            onRetry={onRetry}
          />
        ))}
      </div>
      {historyJobs.length > COLLAPSED_HISTORY_COUNT && (
        <button
          aria-expanded={isHistoryExpanded}
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-2xl text-xs font-medium text-stone-500 transition hover:bg-stone-100/70 hover:text-ink dark:text-stone-400 dark:hover:bg-white/[0.05] dark:hover:text-night-ink"
          onClick={() => setIsHistoryExpanded((expanded) => !expanded)}
          type="button"
        >
          {isHistoryExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {isHistoryExpanded ? '收起历史记录' : `再看 ${historyJobs.length - COLLAPSED_HISTORY_COUNT} 条翻译记录`}
        </button>
      )}
    </section>
  );
}

function TranslationTaskRow({ actionError, isBusy, isSuperseded, job, modelOptions, onConcurrencyChange, onDelete, onModelChange, onPause, onResume, onRetry }: {
  actionError?: string;
  isBusy: boolean;
  isSuperseded: boolean;
  job: WholeBookTranslationJob;
  modelOptions: TranslationModelOption[];
  onConcurrencyChange: (jobId: string, value: number) => void;
  onDelete: (job: WholeBookTranslationJob) => void;
  onModelChange: (jobId: string, model: string, channelId: string | null) => void;
  onPause: (jobId: string) => void;
  onResume: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}) {
  const statusMessage = isSuperseded ? '对应章节已由后续任务发布，以下保留本次尝试的失败进度。' : getWholeBookTranslationStatusMessage(job);
  const Icon = isBusy ? LoaderCircle : isSuperseded ? Clock : {
    queued: LoaderCircle, processing: LoaderCircle, paused: Pause, waiting_quota: Clock,
    review: BookOpen, ready: Check, rejected: CircleMinus, failed: AlertCircle,
  }[job.status];
  return (
    <div aria-busy={isBusy} aria-label={`《${job.title}》翻译任务`} className="py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent dark:focus-visible:outline-peach" data-task-focus-id={`translation:${job.id}`} key={job.id} role="group" tabIndex={-1}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className={cn(
          'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full',
          job.status === 'ready' && 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-300',
          job.status === 'review' && 'bg-pink-50 text-accent dark:bg-pink-950/20 dark:text-peach',
          job.status === 'failed' && !isSuperseded && 'bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-300',
          isSuperseded && 'bg-stone-100 text-stone-500 dark:bg-white/[0.08] dark:text-night-soft',
          job.status === 'waiting_quota' && 'bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300',
          (job.status === 'paused' || job.status === 'rejected') && 'bg-stone-100 text-stone-500 dark:bg-white/[0.08] dark:text-night-soft',
          (job.status === 'queued' || job.status === 'processing') && 'bg-pink-50 text-accent dark:bg-pink-950/20 dark:text-peach',
        )}>
          <Icon aria-hidden="true" className={cn('h-4 w-4', (isBusy || job.status === 'queued' || job.status === 'processing') && 'animate-spin')} />
        </span>
        <div className="min-w-0 flex-[1_1_10rem]">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 max-w-full truncate text-sm font-medium text-stone-900 dark:text-night-ink" title={job.title}>{job.title}</span>
            <span className="text-[11px] text-stone-500 dark:text-stone-400">{isSuperseded ? '历史失败记录' : getWholeBookTranslationStatusLabel(job)}</span>
          </p>
          <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
            {!isSuperseded && (job.status === 'failed' || job.status === 'waiting_quota')
              ? <TaskErrorMessage message={statusMessage} summary={job.status === 'waiting_quota' ? '额度暂不可用，等待后台自动重试。' : '翻译未完成，请查看错误详情后重试。'} />
              : <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{statusMessage}</p>}
          </div>
          {actionError && <div className="mt-1 text-xs leading-5 text-red-600 dark:text-red-300"><TaskErrorMessage message={actionError} role="alert" summary="操作未完成，请查看错误详情后重试。" /></div>}
          {job.status === 'waiting_quota' && job.quota_resume_at && (
            <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-300">
              预计 {formatResumeTime(job.quota_resume_at)} 额度重置，后台将自动重试
            </span>
          )}
          <span className="mt-1 block text-[11px] tabular-nums text-stone-400 [overflow-wrap:anywhere]">
            {job.job_kind === 'source_update' ? '追加翻译' : '整本翻译'} · {job.completed_chapters}/{job.total_chapters} 话 · 总进度 {job.progress}%
            {job.channel_name ? ` · ${job.channel_name} · ` : ' · '}{job.model}
          </span>
          {(job.completed_chapters > 0 || job.quality_status === 'warning') && (
            <span className={`mt-1 block text-[11px] ${job.quality_status === 'warning' ? 'text-amber-600 dark:text-amber-300' : job.quality_status === 'pending' ? 'text-stone-500 dark:text-stone-400' : 'text-emerald-600 dark:text-emerald-300'}`}>
              {getWholeBookTranslationQualityMessage(job)}
            </span>
          )}
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            {!isSuperseded && !['ready', 'review', 'rejected'].includes(job.status) && (
              <label className="inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] text-stone-400">
                并发
                <select
                  data-task-focus-control="concurrency"
                  aria-label={`《${job.title}》并发请求数`}
                  className="min-h-11 min-w-11 border-0 bg-transparent px-2 text-xs font-medium text-stone-600 outline-none focus:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 dark:text-night-soft"
                  disabled={isBusy}
                  onChange={(event) => onConcurrencyChange(job.id, Number(event.target.value))}
                  value={job.request_concurrency}
                >
                  {job.request_concurrency > job.max_concurrency && <option disabled value={job.request_concurrency}>{job.request_concurrency}（超出当前上限）</option>}
                  {Array.from({ length: job.max_concurrency }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            )}
            {!isSuperseded && MODEL_CHANGE_STATUSES.includes(job.status) && modelOptions.length > 0 && (
              <label className="inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] text-stone-400">
                渠道
                <select
                  data-task-focus-control="model"
                  aria-label={`《${job.title}》使用的渠道和模型`}
                  className="min-h-11 min-w-0 max-w-52 flex-1 border-0 bg-transparent px-2 text-xs font-medium text-stone-600 outline-none focus:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 dark:text-night-soft"
                  disabled={isBusy}
                  onChange={(event) => {
                    const option = modelOptions.find((candidate) => getModelOptionValue(candidate) === event.target.value);
                    if (option?.available) onModelChange(job.id, option.model, option.channel_id);
                  }}
                  value={getModelOptionValue(job)}
                >
                  {!modelOptions.some((option) => option.channel_id === job.channel_id && option.model === job.model) && (
                    <option value={getModelOptionValue(job)}>{job.model}（已失效）</option>
                  )}
                  {modelOptions.map((option) => (
                    <option disabled={!option.available} key={getModelOptionValue(option)} value={getModelOptionValue(option)}>
                      {option.label}{option.available ? '' : '（暂不可用）'}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </span>
        </div>
        <div aria-label={`《${job.title}》任务操作`} className="ml-auto flex max-w-full flex-wrap justify-end" role="group">
        {(job.status === 'queued' || job.status === 'processing' || job.status === 'waiting_quota') && !job.pause_requested && (
          <button data-task-focus-control="pause" data-task-focus-primary aria-label={`暂停《${job.title}》`} className="grid h-11 w-11 shrink-0 place-items-center text-stone-400 transition hover:text-accent disabled:opacity-40" disabled={isBusy} onClick={() => onPause(job.id)} title="暂停并保留已完成进度" type="button">
            <Pause className="h-4 w-4" />
          </button>
        )}
        {(job.status === 'paused' || job.pause_requested) && (
          <button data-task-focus-control="resume" data-task-focus-primary aria-label={`继续《${job.title}》`} className="grid h-11 w-11 shrink-0 place-items-center text-stone-400 transition hover:text-accent disabled:opacity-40" disabled={isBusy} onClick={() => onResume(job.id)} title={job.pause_requested ? '取消暂停' : '继续翻译'} type="button">
            <Play className="h-4 w-4" />
          </button>
        )}
        {(job.status === 'failed' || job.status === 'waiting_quota') && !isSuperseded && (
          <button data-task-focus-control="retry" data-task-focus-primary aria-label={`重试《${job.title}》`} className="grid h-11 w-11 shrink-0 place-items-center text-stone-400 transition hover:text-accent disabled:opacity-40" disabled={isBusy} onClick={() => onRetry(job.id)} title={job.status === 'waiting_quota' ? '立即重试，不等探测' : '从断点继续'} type="button">
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
        {(job.status === 'paused' || job.status === 'ready' || job.status === 'rejected' || job.status === 'failed' || job.status === 'waiting_quota') && (
          <button data-task-focus-control="delete" aria-label={`${job.status === 'paused' ? '放弃' : '删除'}《${job.title}》的翻译记录`} className="grid h-11 w-11 shrink-0 place-items-center text-stone-400 transition hover:text-red-500 disabled:opacity-40" disabled={isBusy} onClick={() => onDelete(job)} title={job.status === 'paused' ? '放弃后续翻译' : '删除翻译记录'} type="button">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
        {job.book_id && (
          <Link data-task-focus-control="open" data-task-focus-primary aria-label={`${job.status === 'review' ? '查看译稿' : '打开'}《${job.title}》`} className="grid h-11 w-11 shrink-0 place-items-center text-stone-400 transition hover:text-accent" title={job.status === 'review' ? '查看并决定是否加入原书' : '打开图书'} to={`${getBookDetailPath(job.book_id)}${job.status === 'review' ? `?translationReview=${encodeURIComponent(job.id)}` : ''}`}>
            <BookOpen className="h-4 w-4" />
          </Link>
        )}
        </div>
      </div>
      {job.status === 'processing' && (
        <div className="mt-2 ml-11 h-1 overflow-hidden rounded-full bg-stone-100 dark:bg-white/[0.07]">
          <div className="h-full rounded-full bg-pink-400 transition-[width] duration-500" style={{ width: `${job.progress}%` }} />
        </div>
      )}
    </div>
  );
}

function getModelOptionValue(option: { channel_id: string | null; model: string }): string {
  return JSON.stringify([option.channel_id, option.model]);
}

function formatResumeTime(value: string): string {
  const parsed = parseAppDate(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { day: 'numeric', hour: '2-digit', minute: '2-digit', month: 'numeric' });
}
