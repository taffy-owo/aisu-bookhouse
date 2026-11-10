import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../../shared/api';
import { clearAuthStorage, setStoredSession } from '../../../shared/api/authTokenStore';
import { clearJapaneseAiTranslationCache, translateJapaneseTexts } from './japaneseAiTranslationService';

vi.mock('../../../shared/api', () => ({ apiRequest: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
type TranslationReply = { model: string; translations: string[] };

describe('translateJapaneseTexts', () => {
  beforeEach(() => {
    clearJapaneseAiTranslationCache();
    vi.mocked(apiRequest).mockReset();
  });

  afterEach(() => {
    clearAuthStorage();
  });

  it('returns translations aligned with source text and reports progress', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ model: 'mimo-v2.5-pro', translations: ['译:原文一', '译:原文二'] });
    const progress: number[] = [];

    const result = await translateJapaneseTexts(['原文一', '原文二'], {
      onProgress: (translations) => progress.push(translations.size),
    });

    expect(result.get('原文一')).toBe('译:原文一');
    expect(result.get('原文二')).toBe('译:原文二');
    expect(progress.at(-1)).toBe(2);
  });

  it('sends chapter context and isolates cached translations by work', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ model: 'model', translations: ['甲作品译文'] })
      .mockResolvedValueOnce({ model: 'model', translations: ['乙作品译文'] });

    const first = await translateJapaneseTexts(['彼女だった。'], { context: { chapterTitle: '第一话', workTitle: '甲作品' } });
    const second = await translateJapaneseTexts(['彼女だった。'], { context: { chapterTitle: '第一话', workTitle: '乙作品' } });

    expect(first.get('彼女だった。')).toBe('甲作品译文');
    expect(second.get('彼女だった。')).toBe('乙作品译文');
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[0][1]?.body as string)).toMatchObject({
      chapter_title: '第一话',
      work_title: '甲作品',
    });
  });

  it('does not reuse cached translations after an account switch', async () => {
    setStoredSession({ id: 'user-a', nickname: '甲', role: 'user' });
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ model: 'model', translations: ['甲账号译文'] })
      .mockResolvedValueOnce({ model: 'model', translations: ['乙账号译文'] });

    const first = await translateJapaneseTexts(['同一句话'], { context: { workTitle: '同一作品' } });
    setStoredSession({ id: 'user-b', nickname: '乙', role: 'user' });
    const second = await translateJapaneseTexts(['同一句话'], { context: { workTitle: '同一作品' } });

    expect(first.get('同一句话')).toBe('甲账号译文');
    expect(second.get('同一句话')).toBe('乙账号译文');
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('splits large paragraph sets into bounded batches', async () => {
    const texts = Array.from({ length: 13 }, (_, index) => `批次原文${index}`);
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ model: 'mimo-v2.5-pro', translations: texts.slice(0, 12).map((text) => `译:${text}`) })
      .mockResolvedValueOnce({ model: 'mimo-v2.5-pro', translations: texts.slice(12).map((text) => `译:${text}`) });

    const result = await translateJapaneseTexts(texts);

    expect(result.size).toBe(13);
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('translates an oversized paragraph without losing text or exceeding request limits', async () => {
    const text = '彼女は窓の外を見た。「雨が止んだね。」'.repeat(800) + '最後の一文。';
    const reports: Map<string, string>[] = [];
    const received: string[] = [];
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      const body = JSON.parse(options?.body as string) as { texts: string[] };
      expect(body.texts.join('').length).toBeLessThanOrEqual(6000);
      received.push(...body.texts);
      return { model: 'model', translations: body.texts };
    });
    const result = await translateJapaneseTexts([text], { onProgress: (value) => reports.push(value) });
    expect(result.get(text)).toBe(text);
    expect(received.length).toBeGreaterThan(1);
    expect(reports.every((value) => value.size === 0 || value.get(text) === text)).toBe(true);
    const calls = vi.mocked(apiRequest).mock.calls.length;
    expect((await translateJapaneseTexts([text])).get(text)).toBe(text);
    expect(apiRequest).toHaveBeenCalledTimes(calls);
  });

  it('bounds transmitted titles without splitting Unicode or merging different full contexts', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ model: 'model', translations: ['译文'] });
    const title = '🌸'.repeat(255);
    await translateJapaneseTexts(['原文'], { context: { chapterTitle: title + '甲', workTitle: title + '甲' } });
    await translateJapaneseTexts(['原文'], { context: { chapterTitle: title + '乙', workTitle: title + '乙' } });
    expect(apiRequest).toHaveBeenCalledTimes(2);
    const bodies = vi.mocked(apiRequest).mock.calls.map(([, options]) => JSON.parse(options?.body as string));
    for (const body of bodies) {
      expect(Array.from(body.chapter_title).length).toBeLessThanOrEqual(255);
      expect(Array.from(body.work_title).length).toBeLessThanOrEqual(255);
      expect(body.work_title.startsWith('🌸')).toBe(true);
      expect(/[\uD800-\uDFFF]/u.test(body.work_title)).toBe(false);
    }
    // The backend derives its cache identity from the transmitted context.
    expect(bodies[0].work_title).not.toBe(bodies[1].work_title);
    expect(bodies[0].chapter_title).not.toBe(bodies[1].chapter_title);
    clearJapaneseAiTranslationCache();
    await translateJapaneseTexts(['原文'], { context: { chapterTitle: title + '甲', workTitle: title + '甲' } });
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[2][1]?.body as string)).toEqual(bodies[0]);
  });

  it('preserves whitespace between separately translated sentence chunks', async () => {
    const first = 'あ'.repeat(5000) + '。';
    const second = 'い'.repeat(5000) + '。';
    const text = first + '\n\n' + second + ' ' + first;
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      const body = JSON.parse(options?.body as string) as { texts: string[] };
      return { model: 'model', translations: body.texts.map((part) => part === first ? '前。' : '后。') };
    });
    expect((await translateJapaneseTexts([text])).get(text)).toBe('前。\n\n后。 前。');
  });

  it('does not start a request if cancelled while preparing an oversized title', async () => {
    const digest = deferred<ArrayBuffer>();
    const hashing = vi.spyOn(crypto.subtle, 'digest').mockReturnValue(digest.promise);
    try {
      const controller = new AbortController();
      const result = translateJapaneseTexts(['原文'], { context: { workTitle: 'あ'.repeat(256) }, signal: controller.signal });
      const cancelled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await cancelled;
      digest.resolve(new ArrayBuffer(32));
      await Promise.resolve();
      await Promise.resolve();
      expect(apiRequest).not.toHaveBeenCalled();
    } finally {
      hashing.mockRestore();
    }
  });

  it('keeps supplementary characters intact when a long unpunctuated paragraph must be split', async () => {
    const text = 'あ'.repeat(5999) + '𠮷' + 'い'.repeat(6500);
    const received: string[] = [];
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      const body = JSON.parse(options?.body as string) as { texts: string[] };
      received.push(...body.texts);
      return { model: 'model', translations: body.texts };
    });
    expect((await translateJapaneseTexts([text])).get(text)).toBe(text);
    expect(received.join('')).toBe(text);
    expect(received.every((part) => part.length <= 6000 && !/[\uD800-\uDFFF]/u.test(part))).toBe(true);
  });

  it('retries only missing chunks and never reports a partial paragraph as complete', async () => {
    const first = 'あ'.repeat(5000) + '。';
    const second = 'い'.repeat(5000) + '。';
    const text = first + second;
    const progress = vi.fn();
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ model: 'model', translations: ['前半。'] })
      .mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValueOnce({ model: 'model', translations: ['后半。'] });
    await expect(translateJapaneseTexts([text], { onProgress: progress })).rejects.toThrow('连接中断');
    expect(progress.mock.calls.every(([result]) => result.size === 0)).toBe(true);
    expect((await translateJapaneseTexts([text])).get(text)).toBe('前半。后半。');
    const sent = vi.mocked(apiRequest).mock.calls.map(([, options]) => JSON.parse(options?.body as string).texts);
    expect(sent).toEqual([[first], [second], [second]]);
  });

  it('shares oversized paragraphs with another consumer and cancels only the departing reader', async () => {
    const text = 'あ'.repeat(6000) + 'い'.repeat(1000);
    const pending = deferred<TranslationReply>();
    vi.mocked(apiRequest).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ model: 'model', translations: ['末尾。'] });
    const controller = new AbortController();
    const chapter = translateJapaneseTexts([text], { signal: controller.signal });
    const sentence = translateJapaneseTexts([text]);
    const aborted = expect(chapter).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await aborted;
    expect(vi.mocked(apiRequest).mock.calls[0][1]?.signal?.aborted).toBe(false);
    pending.resolve({ model: 'model', translations: ['开头。'] });
    expect((await sentence).get(text)).toBe('开头。末尾。');
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('shares a pending paragraph between chapter and sentence translation', async () => {
    let resolve!: (value: { model: string; translations: string[] }) => void;
    vi.mocked(apiRequest).mockReturnValue(new Promise((done) => { resolve = done; }));
    const options = { context: { chapterTitle: '第一话', workTitle: '同一作品' } };
    const chapter = translateJapaneseTexts(['彼女だった。', '雨が降った。'], options);
    const sentence = translateJapaneseTexts(['彼女だった。'], options);
    const calls = vi.mocked(apiRequest).mock.calls.length;
    resolve({ model: 'model', translations: ['她。', '下雨了。'] });
    const [chapterResult, sentenceResult] = await Promise.all([chapter, sentence]);
    expect(calls).toBe(1);
    expect(chapterResult.size).toBe(2);
    expect([...sentenceResult]).toEqual([['彼女だった。', '她。']]);
  });

  it('cancels only one consumer while another keeps the shared request', async () => {
    const pending = deferred<TranslationReply>();
    vi.mocked(apiRequest).mockReturnValueOnce(pending.promise);
    const signal = new AbortController();
    const progress = vi.fn();
    const chapter = translateJapaneseTexts(['彼女だった。'], { signal: signal.signal, onProgress: progress });
    const sentence = translateJapaneseTexts(['彼女だった。']);
    const aborted = expect(chapter).rejects.toMatchObject({ name: 'AbortError' });
    signal.abort();
    await aborted;
    expect(vi.mocked(apiRequest).mock.calls[0][1]?.signal?.aborted).toBe(false);
    pending.resolve({ model: 'model', translations: ['她。'] });
    expect((await sentence).get('彼女だった。')).toBe('她。');
    expect(progress).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('aborts transport when all consumers leave and ignores its late response', async () => {
    const pending = deferred<TranslationReply>();
    vi.mocked(apiRequest).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ model: 'model', translations: ['新译文'] });
    const signal = new AbortController();
    const abandoned = translateJapaneseTexts(['彼女だった。'], { signal: signal.signal });
    const aborted = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    signal.abort();
    await aborted;
    expect(vi.mocked(apiRequest).mock.calls[0][1]?.signal?.aborted).toBe(true);
    const replacement = translateJapaneseTexts(['彼女だった。']);
    pending.resolve({ model: 'model', translations: ['已取消的旧译文'] });
    expect((await replacement).get('彼女だった。')).toBe('新译文');
    expect((await translateJapaneseTexts(['彼女だった。'])).get('彼女だった。')).toBe('新译文');
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('never sends or reports progress for an already cancelled call', async () => {
    const signal = new AbortController();
    const progress = vi.fn();
    signal.abort();
    await expect(translateJapaneseTexts(['彼女だった。'], { signal: signal.signal, onProgress: progress })).rejects.toMatchObject({ name: 'AbortError' });
    expect(apiRequest).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it('rechecks later chapter paragraphs after a separate sentence finishes', async () => {
    const texts = Array.from({ length: 13 }, (_, index) => `原文${index}`);
    const first = deferred<TranslationReply>();
    vi.mocked(apiRequest).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ model: 'model', translations: ['选句译文'] });
    const chapter = translateJapaneseTexts(texts);
    await translateJapaneseTexts([texts[12]]);
    first.resolve({ model: 'model', translations: texts.slice(0, 12).map((text) => `译:${text}`) });
    const result = await chapter;
    expect(result.size).toBe(13);
    expect(result.get(texts[12])).toBe('选句译文');
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('shares overlapping paragraphs while requesting new paragraphs only once', async () => {
    const first = deferred<TranslationReply>();
    vi.mocked(apiRequest).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ model: 'model', translations: ['丙'] });
    const chapter = translateJapaneseTexts(['甲原文', '乙原文']);
    const second = translateJapaneseTexts(['乙原文', '丙原文']);
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[1][1]?.body as string).texts).toEqual(['丙原文']);
    first.resolve({ model: 'model', translations: ['甲', '乙'] });
    expect([...await chapter]).toEqual([['甲原文', '甲'], ['乙原文', '乙']]);
    expect((await second).size).toBe(2);
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('rejects a shared failure and allows a clean retry', async () => {
    const pending = deferred<TranslationReply>();
    vi.mocked(apiRequest).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ model: 'model', translations: ['重试译文'] });
    const chapter = translateJapaneseTexts(['彼女だった。']);
    const sentence = translateJapaneseTexts(['彼女だった。']);
    const results = Promise.allSettled([chapter, sentence]);
    pending.reject(new Error('翻译暂时不可用'));
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    expect((await translateJapaneseTexts(['彼女だった。'])).get('彼女だった。')).toBe('重试译文');
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('discards a pending response after switching accounts', async () => {
    setStoredSession({ id: 'user-a', nickname: '甲', role: 'user' });
    const pending = deferred<TranslationReply>();
    vi.mocked(apiRequest).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ model: 'model', translations: ['乙账号译文'] });
    const first = translateJapaneseTexts(['彼女だった。']);
    const old = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    setStoredSession({ id: 'user-b', nickname: '乙', role: 'user' });
    pending.resolve({ model: 'model', translations: ['甲账号迟到译文'] });
    await old;
    expect((await translateJapaneseTexts(['彼女だった。'])).get('彼女だった。')).toBe('乙账号译文');
  });

  it('clears pending cache ownership without allowing an old request to replace a new one', async () => {
    const pending = deferred<TranslationReply>();
    vi.mocked(apiRequest).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ model: 'model', translations: ['新译文'] });
    const first = translateJapaneseTexts(['彼女だった。']);
    const old = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    clearJapaneseAiTranslationCache();
    await old;
    const replacement = translateJapaneseTexts(['彼女だった。']);
    pending.resolve({ model: 'model', translations: ['清除前译文'] });
    expect((await replacement).get('彼女だった。')).toBe('新译文');
    expect((await translateJapaneseTexts(['彼女だった。'])).get('彼女だった。')).toBe('新译文');
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('validates the entire batch before placing any translated paragraph in cache', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ model: 'model', translations: ['第一段译文', ' '] }).mockResolvedValueOnce({ model: 'model', translations: ['重试第一段', '重试第二段'] });
    await expect(translateJapaneseTexts(['第一段', '第二段'])).rejects.toThrow('AI 返回了空译文');
    expect((await translateJapaneseTexts(['第一段', '第二段'])).size).toBe(2);
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[1][1]?.body as string).texts).toEqual(['第一段', '第二段']);
  });
});
