import { describe, expect, it } from 'vitest';
import { buildPdfPageReflow, buildPdfReflowParagraphs } from './pdfTextReflow';
import type { PdfTextItemLike } from './pdfTextReflow';

function item(str: string, x: number, y: number, width: number): PdfTextItemLike {
  return { height: 12, str, transform: [12, 0, 0, 12, x, y], width };
}

describe('PDF text reflow', () => {
  it('joins wrapped CJK lines and keeps real paragraph endings', () => {
    const result = buildPdfReflowParagraphs([
      item('母女一起在厨房里的一天化为乌有了。回忆消失了。', 90, 614, 421),
      item('跟着母亲学做点心也好，只在指尖留下痕迹。', 90, 590, 276),
      item('不想承认这个事实，所以我没有向现实妥协。', 90, 567, 421),
      item('我也无法改变自己的态度。', 90, 543, 144),
    ], 595);

    expect(result.paragraphs).toEqual([
      '母女一起在厨房里的一天化为乌有了。回忆消失了。跟着母亲学做点心也好，只在指尖留下痕迹。',
      '不想承认这个事实，所以我没有向现实妥协。我也无法改变自己的态度。',
    ]);
  });

  it('joins split punctuation on the same visual line', () => {
    const result = buildPdfReflowParagraphs([
      item('「', 90, 730, 12),
      item('菜刀要等你再大一些才能用……', 102, 730, 168),
      item('」', 270, 730, 12),
    ], 595);

    expect(result.paragraphs).toEqual(['「菜刀要等你再大一些才能用……」']);
  });

  it('drops page numbers placed in the outer margin', () => {
    const result = buildPdfReflowParagraphs([
      item('正文内容不会被删除。', 90, 730, 120),
      item('21', 505, 70, 12),
    ], 595, 842);

    expect(result.paragraphs).toEqual(['正文内容不会被删除。']);
    expect(result.characterCount).toBe(10);
  });

  it('falls back to the original page for multi-column layouts', () => {
    const result = buildPdfReflowParagraphs([
      item('左栏的一行正文内容', 50, 700, 150),
      item('右栏的一行正文内容', 340, 700, 150),
      item('左栏的下一行正文', 50, 680, 150),
      item('右栏的下一行正文', 340, 680, 150),
    ], 595);

    expect(result).toEqual({ characterCount: 0, paragraphs: [] });
  });
});


describe('PDF reflow text fidelity', () => {
  it('uses the cropped page origin to distinguish a numeric note from a footer', () => {
    const items = [item('The number written below:', 1260, 1540, 300), item('123', 1710, 1200, 21), item('1', 1496, 828, 8)];
    const original = structuredClone(items);
    expect(buildPdfPageReflow(items, [1200, 800, 1800, 1640]).paragraphs).toEqual(['The number written below:', '123']);
    expect(items).toEqual(original);
  });
  it('preserves the original page if its bounds cannot be interpreted', () => {
    expect(buildPdfPageReflow([item('An intact original page', 60, 700, 300)], [0, 0, 0, 840])).toEqual({ characterCount: 0, paragraphs: [] });
  });
  it.each([
    ['The rain stopped.', 'She opened the letter.', 'The rain stopped. She opened the letter.'],
    ['She whispered,', 'then waited.', 'She whispered, then waited.'],
    ['She closed the book:', 'the room was quiet.', 'She closed the book: the room was quiet.'],
    ['She said “good night.”', 'Then she left.', 'She said “good night.” Then she left.'],
    ['Elle aime le café', 'été comme hiver.', 'Elle aime le café été comme hiver.'],
    ['Она закрыла книгу.', 'Затем наступила тишина.', 'Она закрыла книгу. Затем наступила тишина.'],
    ['Η βροχή σταμάτησε.', 'Άνοιξε το γράμμα.', 'Η βροχή σταμάτησε. Άνοιξε το γράμμα.'],
    ['그녀는 책을 덮었다.', '그리고 편지를 읽었다.', '그녀는 책을 덮었다. 그리고 편지를 읽었다.'],
    ['雨が止んだ。', '彼女は手紙を開いた。', '雨が止んだ。彼女は手紙を開いた。'],
    ['那封写满了心事的', '信，终于寄了出去。', '那封写满了心事的信，终于寄了出去。'],
    ['She remembered a well-', 'known story.', 'She remembered a well-known story.'],
  ])('preserves wrapped text: %s / %s', (left, right, expected) => {
    expect(buildPdfReflowParagraphs([item(left, 60, 700, 470), item(right, 60, 676, 470)], 600).paragraphs).toEqual([expected]);
  });

  it('retains explicit space items after punctuation', () => {
    expect(buildPdfReflowParagraphs([
      item('Hello,', 60, 700, 36), item(' ', 96, 700, 4), item('world.', 100, 700, 36),
    ], 600).paragraphs).toEqual(['Hello, world.']);
  });
  it('uses a visible word gap after punctuation without splitting adjacent glyph runs', () => {
    expect(buildPdfReflowParagraphs([
      item('Hello,', 60, 700, 36), item('world.', 104, 700, 36),
    ], 600).paragraphs).toEqual(['Hello, world.']);
    expect(buildPdfReflowParagraphs([
      item('re', 60, 700, 12), item('ad', 72, 700, 12), item('ing', 84, 700, 18),
    ], 600).paragraphs).toEqual(['reading']);
  });
  it('keeps a full-width paragraph break marked by a larger vertical gap', () => {
    expect(buildPdfReflowParagraphs([
      item('The letter was waiting.', 60, 700, 470),
      item('She opened it slowly.', 60, 676, 470),
      item('Outside, the rain had stopped.', 60, 628, 470),
    ], 600).paragraphs).toEqual(['The letter was waiting. She opened it slowly.', 'Outside, the rain had stopped.']);
  });
  it('keeps a heading separate when its type size changes', () => {
    const heading = item('A letter from home', 60, 730, 470);
    heading.height = 20; heading.transform = [20, 0, 0, 20, 60, 730];
    expect(buildPdfReflowParagraphs([heading, item('She began to read.', 60, 700, 470)], 600).paragraphs).toEqual(['A letter from home', 'She began to read.']);
  });
  it('retains a right-aligned number inside the body', () => {
    const result = buildPdfReflowParagraphs([
      item('The year written on the letter:', 60, 700, 300),
      item('2026', 500, 676, 28),
      item('She remembered that summer.', 60, 652, 300),
    ], 600);
    expect(result.paragraphs).toEqual(['The year written on the letter:', '2026', 'She remembered that summer.']);
  });
  it.each([400, 28])('does not erase a publication year at y=%s', (y) => {
    expect(buildPdfReflowParagraphs([
      item('Publication information', 60, 730, 300), item('2026', 500, y, 28),
    ], 600, 840).paragraphs).toEqual(['Publication information', '2026']);
  });
  it('keeps a numeric note in the middle of a page', () => {
    expect(buildPdfReflowParagraphs([
      item('The number written below:', 60, 730, 300), item('123', 500, 400, 21),
    ], 600, 840).paragraphs).toEqual(['The number written below:', '123']);
  });
  it('does not guess at page-number removal without page bounds', () => {
    expect(buildPdfReflowParagraphs([
      item('The number written below:', 60, 730, 300), item('21', 500, 70, 14),
    ], 600).paragraphs).toEqual(['The number written below:', '21']);
  });
  it('rejects staggered columns instead of interleaving their text', () => {
    const result = buildPdfReflowParagraphs([
      item('Left column, first line.', 40, 700, 200),
      item('Right column, first line.', 340, 690, 200),
      item('Left column, second line.', 40, 676, 200),
      item('Right column, second line.', 340, 666, 200),
    ], 600);
    expect(result).toEqual({ characterCount: 0, paragraphs: [] });
  });
  it.each(['ttb', 'rtl'])('preserves the original page when %s text cannot be ordered safely', (dir) => {
    const annotation = { ...item('A meaningful annotation', 540, 700, 24), dir };
    expect(buildPdfReflowParagraphs([item('The full body text remains visible.', 60, 700, 300), annotation], 600)).toEqual({ characterCount: 0, paragraphs: [] });
  });
  it('does not drop a rotated annotation from a mostly horizontal page', () => {
    const annotation = { ...item('A rotated note', 550, 550, 140), transform: [0, 12, -12, 0, 550, 550] };
    expect(buildPdfReflowParagraphs([item('The full body text remains visible.', 60, 700, 300), annotation], 600)).toEqual({ characterCount: 0, paragraphs: [] });
  });
  it('does not treat horizontal text scaling as a heading size change', () => {
    const stretched = { ...item('The letter was waiting.', 60, 700, 470), transform: [18, 0, 0, 12, 60, 700] };
    expect(buildPdfReflowParagraphs([stretched, item('She opened it slowly.', 60, 676, 470)], 600).paragraphs).toEqual(['The letter was waiting. She opened it slowly.']);
  });
});
