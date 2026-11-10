import { describe, expect, it, vi } from 'vitest';
import { createTranslationSubmissionStorage, type TranslationSubmission } from './translationSubmissionStorage';

const record: TranslationSubmission = {
  id: 'record-a', createdAt: 123, status: 'unconfirmed', error: 'offline', sourceUrl: 'https://kakuyomu.jp/works/123',
  customInstructions: '原设置', model: 'model-a', modelLabel: '模型 A', channelId: null, requestConcurrency: 2,
};
function fixture() {
  const values = new Map<string, string>();
  const browserStorage = {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(),
  };
  const fallback = new Map<string, TranslationSubmission | null>();
  const store = (scope = 'account-a') => createTranslationSubmissionStorage(scope, () => browserStorage, fallback);
  return { values, browserStorage, store };
}

describe('translation submission persistence', () => {
  it('writes per-record keys so interleaved tabs and accounts cannot replace each other', () => {
    const f = fixture(), a = f.store(), b = f.store();
    a.save(record); b.save({ ...record, id: 'record-b' }); f.store('account-b').save({ ...record, customInstructions: '账号 B' });
    a.remove(record.id);
    expect(b.load().records.map((item) => item.id)).toEqual(['record-b']);
    expect(f.store('account-b').load().records[0].customInstructions).toBe('账号 B');
  });

  it('does not truncate a long queue or long translation requirements', () => {
    const f = fixture(); const a = f.store();
    for (let index = 0; index < 80; index += 1) a.save({ ...record, id: `record-${index}`, customInstructions: '原要求'.repeat(2000) });
    const restored = f.store().load().records;
    expect(restored).toHaveLength(80);
    expect(restored.every((item) => item.customInstructions.length === 6000)).toBe(true);
  });

  it('skips corrupt individual records without hiding valid ones', () => {
    const f = fixture(); const a = f.store(); a.save(record);
    const key = [...f.values.keys()][0];
    f.values.set(key.replace('record-a', 'damaged'), '{');
    f.values.set(key.replace('record-a', 'wrong-id'), JSON.stringify(record));
    expect(a.load().records).toEqual([record]);
  });

  it('reports blocked reads and retains fallback records', () => {
    const f = fixture(); const a = f.store(); a.save(record);
    vi.spyOn(f.browserStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(a.load().failed).toBe(true);
    expect(a.warning()).toContain('未能保存或读取');
  });

  it('warns on failed removal and hides it for subsequent route mounts', () => {
    const f = fixture(); const a = f.store(); a.save(record);
    vi.spyOn(f.browserStorage, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    a.remove(record.id);
    expect(f.store().load().records).toEqual([]);
    expect(f.store().warning()).toContain('未能清除');
    expect(f.values.size).toBe(1);
  });

  it('finishes deferred local writes when browser storage becomes available again', () => {
    const f = fixture(); const a = f.store(); a.save(record);
    const blocked = vi.spyOn(f.browserStorage, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    a.remove(record.id); blocked.mockRestore(); a.retryPersistence();
    expect(a.warning()).toBe('');
    expect(f.values.size).toBe(0);
  });
});
