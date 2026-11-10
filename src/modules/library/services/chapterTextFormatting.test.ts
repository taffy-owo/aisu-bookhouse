import { describe, expect, it } from 'vitest';
import { formatPastedChapterText } from './chapterTextFormatting';

describe('formatPastedChapterText', () => {
  it.each([
    '第十二章的线索并不在书页上，而在信里。',
    '第十二章已经结束。',
    '第十二章里没有她的名字',
    '第三次读完这本书，我才留意到章节之间的联系。',
    '序章结束后，她还在等那封信。',
    '番外的故事还没结束。',
    '后记里提到的地点就是这里。',
    '第十二章 ' + '这是一段很长的正文'.repeat(35) + '。',
  ])('keeps narrative opening %s', (opening) => {
    const content = `${opening}\n\n第二段保留。`;
    expect(formatPastedChapterText(content)).toMatchObject({ content, detectedTitle: undefined });
    expect(formatPastedChapterText(content, '第一话 灯下的来信')).toMatchObject({ content, detectedTitle: undefined });
  });

  it.each([
    '第 12 章 再会', '第一章雪夜', '第１０話', '第两百章：归途',
    '第十二章 她来了，为什么又走了！？', '第１２話「夜雨」',
    '序章', '序章 夜色', '後記：写在最后', '番外一 夜雨',
    'Chapter 12: A letter', 'Chapter１２ A letter', 'Extra: A rainy night',
  ])('still detects standalone heading %s', (heading) => {
    expect(formatPastedChapterText(`${heading}\n\n第一段。\n第二段。`)).toMatchObject({
      content: '第一段。\n\n第二段。', detectedTitle: heading,
    });
  });

  it('keeps a prepared body even if its opening equals the chosen title', () => {
    const content = '第 2 章 夜雨\n\n她把这一行又念了一次。';
    expect(formatPastedChapterText(content, '第 2 章 夜雨', { extractTitle: false }).content).toBe(content);
  });
  it('extracts a chapter title and turns single line breaks into paragraphs', () => {
    expect(formatPastedChapterText('第 12 章 再会\n　第一段。  \n\u200b第二段！')).toEqual({
      content: '第一段。\n\n第二段！',
      detectedTitle: '第 12 章 再会',
      paragraphCount: 2,
    });
  });

  it('removes a repeated explicit title', () => {
    expect(formatPastedChapterText('第十三章 夜色\r\n正文。', '第十三章 夜色')).toMatchObject({
      content: '正文。',
      detectedTitle: undefined,
      paragraphCount: 1,
    });
  });

  it('joins lines that clearly came from hard wrapping', () => {
    const wrapped = [
      '这是一段从排版文档复制出来的很长正文，因为原页面栏宽有限所以这里被强制换行',
      '换行处并不代表新的段落，前后内容应当保持连续并在整理后重新接回同一个段落',
      '这种文本的多数行长度相近，而且行尾通常没有句号，因此可以稳定识别为硬换行',
      '最后一行会比其他行稍短。',
    ].join('\n');

    const result = formatPastedChapterText(wrapped);
    expect(result.paragraphCount).toBe(1);
    expect(result.content).not.toContain('\n');
  });

  it('preserves existing blank-separated paragraphs', () => {
    expect(formatPastedChapterText('第一段。\n\n\n第二段。').content).toBe('第一段。\n\n第二段。');
  });

  it('repairs full-width-space blank lines in an existing chapter', () => {
    expect(formatPastedChapterText('第１０話\n　　\n　　第一段。\n　　\n「第二段！」', '第 10 章')).toMatchObject({
      content: '第一段。\n\n「第二段！」',
      paragraphCount: 2,
    });
  });
});

it('keeps a chapter-like first paragraph when formatting an existing body', () => {
  const content = '第十二章的线索并不在书页上，而在信里。\n\n[[AISU_CHAPTER_IMAGE:1]]\n\n第二段保留。';
  expect(formatPastedChapterText(content, '第一话 灯下的来信', { extractTitle: 'matching' }).content).toBe(content);
});

it('removes only an exact repeated title when explicitly formatting an existing body', () => {
  expect(formatPastedChapterText('第一话 灯下的来信\n\n正文。', '第一话 灯下的来信', { extractTitle: 'matching' }).content).toBe('正文。');
});
