import { describe, expect, it } from 'vitest';
import { getAutoParagraphAlignment } from './readerParagraphAlignment';

describe('automatic paragraph alignment', () => {
  it.each([
    'The reader visited 東京, then returned to the quiet library and opened her letter.',
    'Une lettre attendait dans la bibliothèque. Elle regardait les étoiles du soir.',
    '그녀는 도서관에서 책을 펼치고 조용한 저녁에 편지를 읽었다.',
    'فتحت الكتاب في المكتبة وقرأت رسالة طويلة ثم نظرت من النافذة.',
    'https://example.test/abcdefghijklmnopqrstuvwxyz0123456789',
    '2026 / 10 / 25',
    '',
  ])('keeps natural word spacing for %s', (text) => {
    expect(getAutoParagraphAlignment(text)).toBe('start');
  });

  it.each([
    '她在图书馆里读完了来信，等待窗外的雨慢慢停下来。',
    '彼女は窓の外を見つめながら、昨日の出来事を話し始めた。',
    '她读完了 The Long Journey 这个故事，也终于理解了旅途中每一次相遇的意义。',
  ])('justifies predominantly CJK prose %s', (text) => {
    expect(getAutoParagraphAlignment(text)).toBe('justify');
  });
});
