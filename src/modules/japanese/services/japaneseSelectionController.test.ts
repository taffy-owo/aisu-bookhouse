import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJapaneseSelectionController } from './japaneseSelectionController';

const context = { bookId: 'book-a', chapterTitle: '章 A', workTitle: '本 A' };
const dictionary = (query: string) => ({ query, dictionaryForm: query, translation: `释义 ${query}`, available: true, englishGlosses: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  vi.useFakeTimers();
  const account = { id: 'owner-a' };
  const lookup = vi.fn().mockImplementation(async (_book: string | undefined, text: string) => dictionary(text));
  const translate = vi.fn().mockResolvedValue('句子译文');
  const copy = vi.fn().mockResolvedValue(undefined);
  const stopSpeech = vi.fn();
  const speak = vi.fn<(_text: string, onEnd: () => void, onError: (message: string) => void) => () => void>().mockReturnValue(stopSpeech);
  const controller = createJapaneseSelectionController(context, { lookup, translate, copy, speak }, () => account.id);
  return { controller, lookup, translate, copy, account, speak, stopSpeech };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Japanese selection request ownership', () => {
  it('stops speech on manual stop, selection changes and reset without cancelling when idle', () => {
    const { controller, stopSpeech, speak } = fixture();
    controller.reset();
    expect(stopSpeech).not.toHaveBeenCalled();
    controller.select('桜');
    controller.toggleSpeech();
    expect(controller.getSnapshot().isSpeaking).toBe(true);
    controller.toggleSpeech();
    expect(controller.getSnapshot().isSpeaking).toBe(false);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    controller.toggleSpeech();
    controller.select('花');
    expect(stopSpeech).toHaveBeenCalledTimes(2);
    controller.toggleSpeech();
    controller.reset();
    expect(stopSpeech).toHaveBeenCalledTimes(3);
    expect(speak.mock.calls.map(call => call[0])).toEqual(['桜', '桜', '花']);
  });
  it('ignores old speech callbacks and permits retry after a current failure', () => {
    const { controller, speak } = fixture();
    controller.select('桜');
    controller.toggleSpeech();
    const old = speak.mock.calls[0];
    controller.toggleSpeech();
    controller.toggleSpeech();
    old[1]();
    old[2]('过期错误');
    expect(controller.getSnapshot()).toMatchObject({ isSpeaking: true, speechError: '' });
    speak.mock.calls[1][2]('设备朗读失败');
    expect(controller.getSnapshot()).toMatchObject({ isSpeaking: false, speechError: '设备朗读失败' });
    controller.toggleSpeech();
    expect(controller.getSnapshot()).toMatchObject({ isSpeaking: true, speechError: '' });
    speak.mock.calls[2][1]();
    expect(controller.getSnapshot().isSpeaking).toBe(false);
  });
  it('handles unsupported speech and rejects starting speech after an account change', () => {
    const { controller, speak, account } = fixture();
    controller.select('桜');
    speak.mockImplementationOnce(() => { throw new Error('当前浏览器不支持设备朗读'); });
    controller.toggleSpeech();
    expect(controller.getSnapshot()).toMatchObject({ isSpeaking: false, speechError: '当前浏览器不支持设备朗读' });
    account.id = 'another-owner';
    controller.toggleSpeech();
    expect(speak).toHaveBeenCalledTimes(1);
  });
  it('unlocks a new selection immediately and rejects a late result and unlock from the old request', async () => {
    const { controller, lookup } = fixture();
    const old = deferred<ReturnType<typeof dictionary>>();
    const next = deferred<ReturnType<typeof dictionary>>();
    lookup.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    controller.select('さくら');
    const first = controller.request();
    const oldSignal = lookup.mock.calls[0][2] as AbortSignal;
    controller.select('つばき');
    expect(oldSignal.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ text: 'つばき', isLookingUp: false, lookup: null });
    const second = controller.request();
    old.resolve(dictionary('さくら'));
    expect(await first).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ text: 'つばき', lookup: null, isLookingUp: true });
    next.resolve(dictionary('つばき'));
    expect(await second).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ lookup: dictionary('つばき'), isLookingUp: false });
  });
  it('suppresses old failures after selecting another word and retries a current failure', async () => {
    const { controller, lookup } = fixture();
    const old = deferred<ReturnType<typeof dictionary>>();
    lookup.mockReturnValueOnce(old.promise);
    controller.select('さくら');
    const first = controller.request();
    controller.select('つばき');
    old.reject(new Error('旧查询失败'));
    await first;
    expect(controller.getSnapshot().error).toBe('');
    lookup.mockRejectedValueOnce(new Error('当前暂时失败'));
    expect(await controller.request()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ error: '当前暂时失败', isLookingUp: false });
    expect(await controller.request()).toBe(true);
    expect(controller.getSnapshot().error).toBe('');
  });
  it('does not restart an unchanged selection or send a duplicate pending query', async () => {
    const { controller, lookup } = fixture();
    const pending = deferred<ReturnType<typeof dictionary>>();
    lookup.mockReturnValueOnce(pending.promise);
    controller.select('さくら');
    const first = controller.request();
    controller.select(' さくら ');
    expect(await controller.request()).toBe(false);
    expect((lookup.mock.calls[0][2] as AbortSignal).aborted).toBe(false);
    pending.resolve(dictionary('さくら'));
    await first;
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('binds sentence translations to their original context and ignores them after reset', async () => {
    const { controller, translate, lookup } = fixture();
    const pending = deferred<string>();
    translate.mockReturnValueOnce(pending.promise);
    controller.select('これは、ひとつのぶんです。');
    const first = controller.request();
    expect(translate).toHaveBeenCalledWith(context, 'これは、ひとつのぶんです。', expect.any(AbortSignal));
    controller.reset();
    expect((translate.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    pending.resolve('旧句译文');
    expect(await first).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ text: null, aiTranslation: '', isLookingUp: false });
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects late results and new writes after the account changes', async () => {
    const { controller, lookup, account, copy } = fixture();
    const pending = deferred<ReturnType<typeof dictionary>>();
    lookup.mockReturnValueOnce(pending.promise);
    controller.select('さくら');
    const first = controller.request();
    account.id = 'owner-b';
    pending.resolve(dictionary('さくら'));
    expect(await first).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ text: null, lookup: null });
    expect(await controller.request()).toBe(false);
    expect(await controller.copy()).toBe(false);
    expect(copy).not.toHaveBeenCalled();
  });
  it('rejects a mismatched dictionary response and an empty sentence translation', async () => {
    const { controller, lookup, translate } = fixture();
    controller.select('さくら');
    lookup.mockResolvedValueOnce(dictionary('つばき'));
    expect(await controller.request()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ lookup: null, error: '查词结果与所选文字不一致，请重试' });
    controller.select('これは、ひとつのぶんです。');
    translate.mockResolvedValueOnce(' ');
    expect(await controller.request()).toBe(false);
    expect(controller.getSnapshot().error).toBe('AI 没有返回译文，请重试');
  });
  it('ignores a late clipboard confirmation after selection changes', async () => {
    const { controller, copy } = fixture();
    const pending = deferred<void>();
    copy.mockReturnValueOnce(pending.promise);
    controller.select('さくら');
    const first = controller.copy();
    controller.select('つばき');
    pending.resolve();
    expect(await first).toBe(false);
    expect(controller.getSnapshot().isCopied).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('gives the latest copy a full confirmation lifetime and removes its timer on close', async () => {
    const { controller } = fixture();
    controller.select('さくら');
    await controller.copy();
    vi.advanceTimersByTime(700);
    await controller.copy();
    vi.advanceTimersByTime(700);
    expect(controller.getSnapshot().isCopied).toBe(true);
    controller.reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getSnapshot().isCopied).toBe(false);
  });
  it('reports a current clipboard failure without an unhandled rejection', async () => {
    const { controller, copy } = fixture();
    controller.select('さくら');
    copy.mockRejectedValueOnce(new Error('无法访问剪贴板'));
    expect(await controller.copy()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ isCopied: false, copyError: '无法访问剪贴板', error: '' });
  });
  it('clears a clipboard failure on retry without hiding an independent lookup failure', async () => {
    const { controller, copy, lookup } = fixture();
    controller.select('さくら');
    lookup.mockRejectedValueOnce(new Error('词典暂时不可用'));
    await controller.request();
    copy.mockRejectedValueOnce(new Error('无法访问剪贴板'));
    await controller.copy();
    expect(controller.getSnapshot()).toMatchObject({ error: '词典暂时不可用', copyError: '无法访问剪贴板' });
    expect(await controller.copy()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ isCopied: true, copyError: '', error: '词典暂时不可用' });
    await controller.request();
    expect(controller.getSnapshot()).toMatchObject({ error: '', copyError: '', lookup: dictionary('さくら') });
  });
  it('does not erase a clipboard failure when an independent lookup finishes', async () => {
    const { controller, copy, lookup } = fixture();
    const pending = deferred<ReturnType<typeof dictionary>>();
    lookup.mockReturnValueOnce(pending.promise);
    controller.select('さくら');
    const request = controller.request();
    copy.mockRejectedValueOnce(new Error('无法访问剪贴板'));
    await controller.copy();
    pending.resolve(dictionary('さくら'));
    await request;
    expect(controller.getSnapshot()).toMatchObject({ error: '', copyError: '无法访问剪贴板', lookup: dictionary('さくら') });
    controller.select('つばき');
    expect(controller.getSnapshot()).toMatchObject({ error: '', copyError: '', lookup: null });
  });
});
