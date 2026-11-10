import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearManualBookDraft, EMPTY_MANUAL_BOOK_DRAFT, mergeRecoveredManualBookDraft, parseManualBookTags, prepareManualBook, readManualBookDraft, resolveManualBookTitle, writeManualBookDraft } from './manualBookDraft';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('manualBookDraft', () => {
  it('preserves a recovered submission receipt when the form has not been edited', () => {
    const recovered = { ...EMPTY_MANUAL_BOOK_DRAFT, content: '旧正文', requestId: 'one-submission', submittedAt: '2026-10-30' };
    expect(mergeRecoveredManualBookDraft(EMPTY_MANUAL_BOOK_DRAFT, EMPTY_MANUAL_BOOK_DRAFT, recovered)).toEqual(recovered);
  });
  it('merges newly edited metadata with recovered article text and invalidates the older submission receipt', () => {
    const recovered = { ...EMPTY_MANUAL_BOOK_DRAFT, content: '旧正文', title: '旧书名', requestId: 'old-submission', submittedAt: '2026-10-30' };
    expect(mergeRecoveredManualBookDraft({ ...EMPTY_MANUAL_BOOK_DRAFT, title: '新书名' }, EMPTY_MANUAL_BOOK_DRAFT, recovered)).toMatchObject({ content: '旧正文', title: '新书名', requestId: undefined, submittedAt: undefined });
  });
  it('never replaces newer article text during recovery', () => {
    expect(mergeRecoveredManualBookDraft({ ...EMPTY_MANUAL_BOOK_DRAFT, content: '新正文' }, EMPTY_MANUAL_BOOK_DRAFT, { ...EMPTY_MANUAL_BOOK_DRAFT, content: '旧正文' }).content).toBe('新正文');
  });
  it('keeps a chapter-like opening sentence in the uploaded TXT body', async () => {
    const body = '第十二章的线索并不在书页上，而在信里。\n\n第二段保留。';
    const prepared = prepareManualBook({ author: '', content: body, description: '', publicationStatus: 'completed', sourceUrl: '', tags: '', title: '灯下的来信' });
    expect(await prepared.file.text()).toBe(`${body}\n`);
    expect(prepared.metadata.title).toBe('灯下的来信');
  });
  it('keeps all metadata optional and infers a short first-line title', async () => {
    const prepared = prepareManualBook({
      author: '',
      content: '雨夜的信\r\n\r\n这是文章正文。',
      description: '',
      publicationStatus: 'completed',
      sourceUrl: '',
      tags: '',
      title: '',
    });

    expect(prepared.title).toBe('雨夜的信');
    expect(prepared.file.name).toBe('雨夜的信.txt');
    expect(await prepared.file.text()).toBe('雨夜的信\n\n这是文章正文。\n');
    expect(prepared.metadata).toEqual({ publicationStatus: 'completed', title: '雨夜的信' });
  });

  it('uses a dated fallback when the first line is too long to be a useful title', () => {
    const title = resolveManualBookTitle('', '这是一段超过六十个字符而且没有单独标题的正文，继续补充内容以确保它不会被直接用作作品名称，因为那会让书架上的标题非常难以浏览。', new Date(2026, 6, 21));

    expect(title).toBe('手动文章 2026-07-21');
  });

  it('deduplicates comma-separated Chinese and English tags', () => {
    expect(parseManualBookTags('短篇，翻译, 短篇\n日文')).toEqual(['短篇', '翻译', '日文']);
  });

  it('sanitizes characters that cannot appear in a Windows file name', () => {
    const prepared = prepareManualBook({
      author: '作者',
      content: '正文',
      description: '简介',
      publicationStatus: 'ongoing',
      sourceUrl: 'https://kakuyomu.jp/works/1',
      tags: '短篇',
      title: '标题: 第一/话?',
    });

    expect(prepared.file.name).toBe('标题 第一 话.txt');
    expect(prepared.metadata).toEqual({
      author: '作者',
      description: '简介',
      publicationStatus: 'ongoing',
      sourceUrl: 'https://kakuyomu.jp/works/1',
      tags: ['短篇'],
      title: '标题: 第一/话?',
    });
  });

  it('restores and clears a locally saved manual draft', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    const draft = {
      author: '作者',
      content: '尚未保存的正文',
      description: '',
      publicationStatus: 'ongoing' as const,
      sourceUrl: '',
      tags: '翻译',
      title: '草稿',
    };

    writeManualBookDraft(draft);
    expect(readManualBookDraft()).toEqual(draft);
    clearManualBookDraft();
    expect(readManualBookDraft()).toBeNull();
  });

  it('does not retain metadata from a source lookup when no article text was pasted', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    const metadataOnlyDraft = {
      author: '作者',
      content: '',
      description: '读取到的简介',
      publicationStatus: 'ongoing' as const,
      sourceUrl: 'https://kakuyomu.jp/works/1',
      tags: '百合',
      title: '读取到的标题',
    };

    writeManualBookDraft(metadataOnlyDraft);

    expect(readManualBookDraft()).toBeNull();
    expect(store.size).toBe(0);
  });

  it('removes an old metadata-only draft during recovery', () => {
    const storageKey = 'aisu-bookhouse:manual-book-draft';
    const store = new Map<string, string>([[storageKey, JSON.stringify({
      author: '作者',
      content: '',
      description: '旧简介',
      publicationStatus: 'ongoing',
      sourceUrl: 'https://kakuyomu.jp/works/old',
      tags: '旧标签',
      title: '旧标题',
    })]]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });

    expect(readManualBookDraft()).toBeNull();
    expect(store.has(storageKey)).toBe(false);
  });
});
