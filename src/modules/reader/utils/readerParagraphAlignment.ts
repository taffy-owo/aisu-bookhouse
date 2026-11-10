export function getAutoParagraphAlignment(text: string): 'start' | 'justify' {
  // A CJK name inside word-based prose should not stretch the whole paragraph.
  const cjkLetters = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return cjkLetters > 0 && cjkLetters * 2 >= letters ? 'justify' : 'start';
}
