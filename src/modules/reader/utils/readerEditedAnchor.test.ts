import { describe, expect, it } from 'vitest';
import type { ReaderChapter } from '../types/reader';
import type { ReaderViewportAnchor } from './readerViewportAnchor';
import { captureChapterSourceAnchor, createReaderSourceSnapshot, rebaseEditedChapterAnchor, resolveChapterSourceAnchor } from './readerEditedAnchor';

const chapter = (content: string): ReaderChapter => ({ index: 1, title: '来信', content });
const anchor = (sourceOffset: number): ReaderViewportAnchor => ({
  blockIndex: 1, blockText: '原来的段落', offsetRatio: .4, viewportOffset: 80,
  sourceOffset, sourceViewportOffset: 65,
});

describe('saved sentence recovery after an unseen chapter edit', () => {
  const scene = '她把那封等待了很久的来信轻轻放在窗边，终于能够平静地读下去。';
  const before = chapter('之前的事情。\n\n' + scene + '\n\n后来的事情。');
  const source = createReaderSourceSnapshot(before);
  const saved = captureChapterSourceAnchor(anchor(18), source)!;

  it('retains an exact source position for identical prose despite a title or version change', () => {
    expect(resolveChapterSourceAnchor(saved, createReaderSourceSnapshot({ ...before, title: '新的话名', contentVersion: 'different' }))).toEqual(saved);
  });

  it.each([
    ['前面新增了一个段落。\n\n' + before.content, 10],
    [before.content.replace('之前的事情。\n\n', ''), -6],
    [before.content.replace(scene, '补充的前文。' + scene), 6],
  ])('finds a surviving sentence after reopening revised prose %s', (content, shift) => {
    const next = createReaderSourceSnapshot(chapter(content));
    const restored = resolveChapterSourceAnchor(saved, next)!;
    expect(restored.sourceOffset).toBe(saved.sourceOffset! + shift);
    expect(restored.sourceSignature).toBe(next.signature);
    expect(restored.sourceViewportOffset).toBe(saved.sourceViewportOffset);
  });

  it('does not pick a repeated sentence or a removed sentence using an obsolete character offset', () => {
    const repeated = '这一句反复出现，不能只靠相同对白判断读到了哪一处。';
    const first = createReaderSourceSnapshot(chapter('甲'.repeat(120) + repeated + '乙'.repeat(120)));
    const remembered = captureChapterSourceAnchor(anchor(122), first)!;
    const changed = createReaderSourceSnapshot(chapter('丙'.repeat(120) + repeated + '丁'.repeat(120) + repeated + '戊'.repeat(120)));
    expect(resolveChapterSourceAnchor(remembered, changed)).toBeNull();
    expect(resolveChapterSourceAnchor(saved, createReaderSourceSnapshot(chapter('全部改成了别的正文。')))).toBeNull();
  });

  it('keeps repetitive unchanged prose precise and preserves chapter boundaries after revisions', () => {
    const repeated = createReaderSourceSnapshot(chapter('嗯。'.repeat(300)));
    const remembered = captureChapterSourceAnchor(anchor(200), repeated)!;
    expect(resolveChapterSourceAnchor(remembered, repeated)).toEqual(remembered);
    for (const boundary of ['start', 'end'] as const) {
      expect(resolveChapterSourceAnchor({ ...saved, boundary }, createReaderSourceSnapshot(chapter('更长的新正文。')))?.boundary).toBe(boundary);
    }
  });

  it('keeps legacy paragraph recovery without trusting an unversioned source offset', () => {
    const legacy = anchor(12);
    const result = resolveChapterSourceAnchor(legacy, source);
    expect(result).toMatchObject({ blockIndex: legacy.blockIndex, blockText: legacy.blockText, offsetRatio: legacy.offsetRatio });
    expect(result?.sourceOffset).toBeUndefined();
    expect(result?.sourceViewportOffset).toBeUndefined();
  });

  it('bounds stored context while keeping the original position after independent surrounding edits', () => {
    const original = createReaderSourceSnapshot(chapter('前文。'.repeat(100) + scene + '后文。'.repeat(100)));
    const remembered = captureChapterSourceAnchor(anchor(310), original)!;
    expect(remembered.sourceContext?.before.length).toBeLessThanOrEqual(96);
    expect(remembered.sourceContext?.after.length).toBeLessThanOrEqual(96);
    const next = createReaderSourceSnapshot(chapter('新增。' + original.text.replace('后文。'.repeat(100), '后续变化了。')));
    expect(resolveChapterSourceAnchor(remembered, next)?.sourceOffset).toBe(313);
  });
});

describe('reading position after editing a chapter', () => {
  it('follows a sentence after text is inserted in its paragraph', () => {
    const before = chapter('第一段。\n\n这是原来的段落。读到这里以后，还可以继续。');
    const after = chapter('第一段。\n\n补充了很长的一段话。这是原来的段落。读到这里以后，还可以继续。');
    expect(rebaseEditedChapterAnchor(anchor(12), before, after)?.sourceOffset).toBe(22);
  });

  it('follows a sentence after preceding paragraphs are removed', () => {
    expect(rebaseEditedChapterAnchor(anchor(10), chapter('删去的段落。\n\n保留的段落。'), chapter('保留的段落。'))?.sourceOffset).toBe(4);
  });

  it('finds unique surviving context between independent edits', () => {
    const scene = '她把那封等待了很久的来信轻轻放在窗边，终于能够平静地读下去。';
    const before = chapter('早晨。' + scene + '到了晚上。');
    const after = chapter('很久以前的那个早晨。' + scene + '她睡下了。');
    expect(rebaseEditedChapterAnchor(anchor(18), before, after)?.sourceOffset).toBe(25);
  });

  it('falls back when the reading text was replaced and repeated context is ambiguous', () => {
    const repeated = '这一句在章节中出现过很多次，不能据此选择另一个场景。';
    const before = chapter('甲'.repeat(150) + repeated + '乙'.repeat(150));
    const after = chapter('丙'.repeat(150) + repeated + '丁'.repeat(150) + repeated + '戊'.repeat(150));
    const rebased = rebaseEditedChapterAnchor(anchor(152), before, after);
    expect(rebased).toMatchObject({ blockIndex: 1, offsetRatio: .4 });
    expect(rebased?.sourceOffset).toBeUndefined();
    expect(rebased?.sourceViewportOffset).toBeUndefined();
  });

  it('uses rendered simplified text and excludes images and paragraph separators', () => {
    const before: ReaderChapter = { ...chapter(''), blocks: [
      { type: 'paragraph', text: '軟體開發。' }, { type: 'image', alt: '插图' },
      { type: 'paragraph', text: '繼續閱讀書中的故事。' },
    ] };
    const after = { ...before, blocks: [{ type: 'paragraph' as const, text: '新段落。' }, ...before.blocks!] };
    expect(rebaseEditedChapterAnchor(anchor(7), before, after, true)?.sourceOffset).toBe(11);
  });

  it('preserves an unchanged title edit and chapter start or end intent', () => {
    const current = anchor(3);
    expect(rebaseEditedChapterAnchor(current, chapter('旧正文。'), { ...chapter('旧正文。'), title: '新标题' })).toEqual(current);
    for (const boundary of ['start', 'end'] as const) {
      expect(rebaseEditedChapterAnchor({ ...current, boundary }, chapter('旧正文。'), chapter('补充后的新正文。'))?.boundary).toBe(boundary);
    }
  });
});
