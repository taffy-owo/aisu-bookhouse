import { describe, expect, it } from 'vitest';
import { normalizeJapaneseReadableBlocks } from './japaneseTypography';

describe('normalizeJapaneseReadableBlocks', () => {
  it('repairs visual line breaks inside a Japanese sentence', () => {
    const result = normalizeJapaneseReadableBlocks([
      { text: '彼女はゆっくりと窓を開け、', type: 'paragraph' },
      { text: '朝の空を見上げた。', type: 'paragraph' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.type === 'paragraph' ? result[0].text : '').toBe('彼女はゆっくりと窓を開け、朝の空を見上げた。');
  });

  it('keeps dialogue, completed sentences, headings and decorative breaks separate', () => {
    const result = normalizeJapaneseReadableBlocks([
      { text: '朝になった。', type: 'paragraph' },
      { text: '「おはよう」', type: 'paragraph' },
      { level: 2, text: '第一章', type: 'heading' },
      { text: '※※※', type: 'paragraph' },
    ]);
    expect(result).toHaveLength(4);
  });

  it('preserves ruby spans when joining wrapped lines', () => {
    const result = normalizeJapaneseReadableBlocks([
      { spans: [{ ruby: 'かのじょ', text: '彼女' }, { text: 'は' }], text: '彼女は', type: 'paragraph' },
      { spans: [{ ruby: 'ほん', text: '本' }, { text: 'を読む。' }], text: '本を読む。', type: 'paragraph' },
    ]);
    expect(result[0]?.type === 'paragraph' ? result[0].spans : undefined).toEqual([
      { ruby: 'かのじょ', text: '彼女' },
      { text: 'は' },
      { ruby: 'ほん', text: '本' },
      { text: 'を読む。' },
    ]);
  });
});
