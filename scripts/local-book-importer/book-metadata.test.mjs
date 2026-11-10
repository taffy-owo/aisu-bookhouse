import { describe, expect, it } from 'vitest';
import { cleanTitle, getDisplayTitle, selectDisplayAuthor, selectDisplayTitle } from './book-metadata.mjs';

describe('local book metadata helpers', () => {
  it('uses the file title when EPUB metadata title is a UUID', () => {
    const title = selectDisplayTitle({
      epubTitle: '84526d8a-bf5c-4742-b2d8-6a6eaf9f7f41',
      fileTitle: '雨夜之月 26',
    });

    expect(title).toBe('雨夜之月 26');
  });

  it('keeps useful EPUB metadata titles', () => {
    const title = selectDisplayTitle({
      epubTitle: '雨夜之月 - 卷01',
      fileTitle: '雨夜之月卷 01',
    });

    expect(title).toBe('雨夜之月 - 卷01');
  });

  it('cleans noisy scanner names into readable titles', () => {
    expect(cleanTitle('[Kox][雨夜之月]話021-025')).toBe('雨夜之月话021 - 025');
    expect(cleanTitle('将放言说女生之间不可能的女孩子，在百日之内彻底攻陷的百合故事1')).toBe('将放言说女生之间不可能的女孩子，在百日之内彻底攻陷的百合故事 1');
  });

  it('uses parent folder for numeric file names', () => {
    const title = getDisplayTitle({
      extension: '.epub',
      relativePath: '雨夜之月\\26.epub',
    });

    expect(title).toBe('雨夜之月 26');
  });

  it('does not use unknown or duplicated series names as authors', () => {
    expect(selectDisplayAuthor({ creator: 'Unknown', parentName: '雨夜之月', title: '雨夜之月 26' })).toBe('未知作者');
    expect(
      selectDisplayAuthor({
        creator: '',
        parentName: '将放言说女生之间不可能的女孩子，在百日之内彻底攻陷的百合故事[1 5卷]',
        title: '将放言说女生之间不可能的女孩子，在百日之内彻底攻陷的百合故事 01',
      }),
    ).toBe('未知作者');
  });
});

import { safeDecodeHref } from './epub-metadata.mjs';

describe('epub safeDecodeHref helper', () => {
  it('decodes normal percent-encoded spaces and characters', () => {
    expect(safeDecodeHref('cover%20page.jpg')).toBe('cover page.jpg');
    expect(safeDecodeHref('images/%E5%B0%81%E9%9D%A2.png')).toBe('images/封面.png');
  });

  it('falls back to raw string on malformed percent encoding', () => {
    expect(safeDecodeHref('bad%percent%encoding.jpg')).toBe('bad%percent%encoding.jpg');
    expect(safeDecodeHref('%80invalid')).toBe('%80invalid');
  });

  it('keeps unmodified paths as-is', () => {
    expect(safeDecodeHref('normal-cover.jpg')).toBe('normal-cover.jpg');
  });
});

