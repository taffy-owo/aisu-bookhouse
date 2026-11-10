import { describe, expect, it } from 'vitest';
import { looksLikeSupportedSourceLink } from './sourceMetadataService';

describe('looksLikeSupportedSourceLink', () => {
  it('recognizes shared work and episode links without requiring a scheme', () => {
    expect(looksLikeSupportedSourceLink('作品：kakuyomu.jp/works/123/episodes/456')).toBe(true);
    expect(looksLikeSupportedSourceLink('https://www.pixiv.net/ja/novel/series/755013')).toBe(true);
    expect(looksLikeSupportedSourceLink('ncode.syosetu.com/n2267be/12/')).toBe(true);
  });

  it('does not trigger lookups for unrelated text', () => {
    expect(looksLikeSupportedSourceLink('今天随便找一篇文章')).toBe(false);
  });
});
