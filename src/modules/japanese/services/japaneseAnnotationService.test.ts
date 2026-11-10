import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../../shared/api';
import { annotateJapaneseBlocks, hasMissingJapaneseAnnotations } from './japaneseAnnotationService';

vi.mock('../../../shared/api', () => ({ apiRequest: vi.fn() }));

beforeEach(() => { vi.mocked(apiRequest).mockReset(); });

describe('hasMissingJapaneseAnnotations', () => {
  it('detects plain Japanese kanji text', () => {
    expect(hasMissingJapaneseAnnotations([{ text: '私は本を読む。', type: 'paragraph' }])).toBe(true);
  });

  it('ignores kana-only and already annotated text', () => {
    expect(hasMissingJapaneseAnnotations([{ text: 'ひらがなだけ。', type: 'paragraph' }])).toBe(false);
    expect(hasMissingJapaneseAnnotations([{
      spans: [{ ruby: 'きょり', text: '距離' }],
      text: '距離',
      type: 'paragraph',
    }])).toBe(false);
  });
});

describe('annotateJapaneseBlocks', () => {
  it('retains every result in a chapter larger than the shared cache', async () => {
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      const { texts } = JSON.parse(options?.body as string) as { texts: string[] };
      return { annotations: texts.map((text) => ({ text, spans: [{ text, ruby: 'よみ' }] })) };
    });
    const blocks = Array.from({ length: 1105 }, (_, index) => ({ type: 'paragraph' as const, text: `長章の本文${index}`, spans: [{ text: `長章の本文${index}`, marks: ['strong' as const] }] }));
    const annotated = await annotateJapaneseBlocks(blocks);
    expect(apiRequest).toHaveBeenCalledTimes(4);
    expect(annotated).toEqual(blocks.map((block) => ({ ...block, spans: [{ ...block.spans[0], ruby: 'よみ' }] })));
  });

  it('keeps cached results for the current reader when a later batch evicts them', async () => {
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      const { texts } = JSON.parse(options?.body as string) as { texts: string[] };
      return { annotations: texts.map((text) => ({ text, spans: [{ text, ruby: 'よみ' }] })) };
    });
    const first = { type: 'paragraph' as const, text: '先に読んだ注音' };
    await annotateJapaneseBlocks([first]);
    const blocks = [first, ...Array.from({ length: 1005 }, (_, index) => ({ type: 'paragraph' as const, text: `後から来た本文${index}` }))];
    const annotated = await annotateJapaneseBlocks(blocks);
    expect(annotated).toEqual(blocks.map((block) => ({ ...block, spans: [{ text: block.text, ruby: 'よみ', marks: undefined }] })));
    const sent = vi.mocked(apiRequest).mock.calls.slice(1).flatMap(([, options]) => JSON.parse(options?.body as string).texts);
    expect(sent).not.toContain(first.text);
  });

  it('never splits supplementary characters at the request length boundary', async () => {
    const sent: string[] = [];
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      const { texts } = JSON.parse(options?.body as string) as { texts: string[] };
      sent.push(...texts);
      return { annotations: texts.map((text) => ({ text, spans: [{ text, ruby: 'よみ' }] })) };
    });
    const text = '漢'.repeat(19999) + '𠮷🌸' + '字'.repeat(20000);
    const [block] = await annotateJapaneseBlocks([{ type: 'paragraph', text }]);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((chunk) => chunk.length <= 20000 && !/[\uD800-\uDBFF]$/u.test(chunk) && !/^[\uDC00-\uDFFF]/u.test(chunk))).toBe(true);
    expect(sent.join('')).toBe(text);
    expect(block.type !== 'image' && block.spans?.map((span) => span.text).join('')).toBe(text);
  });
});
