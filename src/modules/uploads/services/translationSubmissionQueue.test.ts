import { describe, expect, it, vi } from 'vitest';
import { createTranslationSubmissionQueue } from './translationSubmissionQueue';
import { createTranslationSubmissionStorage, type TranslationSubmission, type TranslationSubmissionInput } from './translationSubmissionStorage';
import type { WholeBookTranslationJob } from './wholeBookTranslationService';

const input: TranslationSubmissionInput = {
  sourceUrl: 'https://kakuyomu.jp/works/123', customInstructions: '保留译名', model: 'model-a', channelId: 'channel-a', modelLabel: '模型 A', requestConcurrency: 3,
};

function fixture() {
  const values = new Map<string, string>();
  const fallback = new Map<string, TranslationSubmission | null>();
  const browserStorage = {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(),
  };
  let scope = 'account-a';
  const requests: Array<{ input: TranslationSubmissionInput; signal: AbortSignal; resolve: (job: WholeBookTranslationJob) => void; reject: (error: unknown) => void }> = [];
  const onCreated = vi.fn();
  const create = vi.fn((snapshot: TranslationSubmissionInput, signal: AbortSignal) => new Promise<WholeBookTranslationJob>((resolve, reject) => requests.push({ input: snapshot, signal, resolve, reject })));
  const storage = (owner = scope) => createTranslationSubmissionStorage(owner, () => browserStorage, fallback);
  const makeQueue = () => createTranslationSubmissionQueue({ scope, getAccountScope: () => scope, create, onCreated, storage: storage() });
  const queue = makeQueue(); queue.activate();
  return { queue, values, browserStorage, requests, onCreated, create, storage, makeQueue, setScope: (next: string) => { scope = next; } };
}
const job = { id: 'server-job' } as WholeBookTranslationJob;
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('translation submission recovery', () => {
  it('persists each original request before sending and retains out-of-order failures', async () => {
    const f = fixture();
    const first = { ...input };
    f.queue.enqueue(first);
    expect(f.storage().load().records[0]).toMatchObject({ ...input, status: 'pending' });
    first.customInstructions = '下一本的新要求';
    f.queue.enqueue({ ...input, sourceUrl: 'https://kakuyomu.jp/works/456', customInstructions: '第二本要求' });
    f.requests[1].reject(new Error('第二本网络错误')); await settle();
    f.requests[0].reject(new Error('第一本网络错误')); await settle();
    expect(f.queue.getSnapshot().submissions).toHaveLength(2);
    expect(f.queue.getSnapshot().submissions.find((record) => record.sourceUrl === input.sourceUrl)).toMatchObject({ customInstructions: '保留译名', error: '第一本网络错误', status: 'unconfirmed' });
    expect(f.queue.getSnapshot().submissions.find((record) => record.sourceUrl.endsWith('/456'))).toMatchObject({ customInstructions: '第二本要求', error: '第二本网络错误' });
    const id = f.queue.getSnapshot().submissions.find((record) => record.sourceUrl === input.sourceUrl)!.id;
    const retry = f.queue.retry(id);
    expect(f.requests[2].input).toMatchObject(input);
    f.requests[2].resolve(job); await retry;
    expect(f.queue.getSnapshot().submissions).toHaveLength(1);
    expect(f.storage().load().records).toHaveLength(1);
    expect(f.onCreated).toHaveBeenCalledExactlyOnceWith(job);
  });

  it('guards same-tick double submission and repeated retry while pending', async () => {
    const f = fixture();
    expect(f.queue.enqueue(input)).toBe(true);
    expect(f.queue.enqueue({ ...input, sourceUrl: ` ${input.sourceUrl} ` })).toBe(false);
    const id = f.queue.getSnapshot().submissions[0].id;
    await f.queue.retry(id);
    f.queue.remove(id);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.queue.getSnapshot().submissions).toHaveLength(1);
    f.requests[0].reject(new Error('failed')); await settle();
    const retry = f.queue.retry(id);
    await f.queue.retry(id);
    expect(f.create).toHaveBeenCalledTimes(2);
    f.requests[1].resolve(job); await retry;
  });

  it('retains interrupted requests through unmount and never resends on return', async () => {
    const f = fixture(); f.queue.enqueue(input);
    f.queue.dispose();
    expect(f.requests[0].signal.aborted).toBe(true);
    const next = f.makeQueue(); next.activate();
    expect(next.getSnapshot().submissions[0]).toMatchObject({ ...input, status: 'unconfirmed' });
    expect(f.create).toHaveBeenCalledTimes(1);
    f.requests[0].resolve(job); await settle();
    expect(f.onCreated).not.toHaveBeenCalled();
    expect(f.storage().load().records).toHaveLength(1);
  });

  it('ignores the old promise after a StrictMode dispose / activate / retry cycle', async () => {
    const f = fixture(); f.queue.enqueue(input);
    const id = f.queue.getSnapshot().submissions[0].id;
    f.queue.dispose(); f.queue.activate();
    const retry = f.queue.retry(id);
    f.requests[0].resolve(job); await settle();
    expect(f.queue.hasPending()).toBe(true);
    expect(f.onCreated).not.toHaveBeenCalled();
    f.requests[1].resolve(job); await retry;
    expect(f.onCreated).toHaveBeenCalledTimes(1);
    expect(f.queue.getSnapshot().submissions).toEqual([]);
  });

  it.each(['resolve', 'reject'] as const)('isolates account changes even when cleanup has not run (%s)', async (result) => {
    const f = fixture(); f.queue.enqueue(input); f.setScope('account-b');
    if (result === 'resolve') f.requests[0].resolve(job); else f.requests[0].reject(new Error('old-account'));
    await settle();
    expect(f.onCreated).not.toHaveBeenCalled();
    expect(f.queue.enqueue(input)).toBe(false);
    f.queue.dispose();
    const second = f.makeQueue(); second.activate();
    expect(second.getSnapshot().submissions).toEqual([]);
    expect(f.storage('account-a').load().records).toHaveLength(1);
    f.setScope('account-a');
    expect(f.makeQueue().getSnapshot().submissions[0]).toMatchObject({ ...input, status: 'unconfirmed' });
  });

  it('keeps complete memory snapshots and reports persistence failures on route return', async () => {
    const f = fixture();
    vi.spyOn(f.browserStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    f.queue.enqueue({ ...input, customInstructions: '长要求'.repeat(2000) });
    expect(f.queue.getSnapshot().storageWarning).toContain('未能保存');
    f.requests[0].reject(new Error('offline')); await settle(); f.queue.dispose();
    const next = f.makeQueue(); next.activate();
    expect(next.getSnapshot().submissions[0].customInstructions).toHaveLength(6000);
    expect(next.getSnapshot().storageWarning).toContain('未能保存');
    const retry = next.retry(next.getSnapshot().submissions[0].id);
    f.requests[1].resolve(job); await retry;
    expect(next.getSnapshot()).toEqual({ submissions: [], storageWarning: '' });
  });

  it('keeps local recovery records when clearing server history and loading unrelated jobs', async () => {
    const f = fixture(); f.queue.enqueue(input); f.requests[0].reject(new Error('offline')); await settle();
    // Polling or clearing server jobs has no authority to erase an unconfirmed request.
    f.queue.reload();
    expect(f.queue.getSnapshot().submissions).toHaveLength(1);
    f.queue.remove(f.queue.getSnapshot().submissions[0].id);
    expect(f.storage().load().records).toEqual([]);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('merges other-tab records without replacing requests in flight', async () => {
    const f = fixture(); f.queue.enqueue(input);
    const current = f.queue.getSnapshot().submissions[0];
    const other = { ...current, id: 'other-tab', sourceUrl: 'https://kakuyomu.jp/works/999', status: 'unconfirmed' as const, error: 'failed elsewhere' };
    f.storage().save(other); f.storage().remove(current.id); f.queue.reload();
    expect(f.queue.getSnapshot().submissions).toHaveLength(2);
    expect(f.queue.getSnapshot().submissions.find((record) => record.id === current.id)?.status).toBe('pending');
    f.requests[0].resolve(job); await settle();
    expect(f.storage().load().records).toEqual([other]);
    f.storage().remove(other.id); f.queue.reload();
    expect(f.queue.getSnapshot().submissions).toEqual([]);
  });
});
