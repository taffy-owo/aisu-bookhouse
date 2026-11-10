import { describe, expect, it } from 'vitest';
import { applySourceMetadata, getSourceMetadataStats } from './sourceMetadataImport';

const sourceMetadata = {
  author: '犬甘あんず',
  character_count: 101_234,
  cover_url: null,
  description: '原作简介',
  episode_count: 39,
  publication_status: 'ongoing' as const,
  source: 'kakuyomu' as const,
  source_url: 'https://kakuyomu.jp/works/16817330649163498808',
  tags: ['百合', '恋爱'],
  title: '原作タイトル',
};

describe('source metadata import', () => {
  it('fills source fields while preserving a translated EPUB title and custom tags', () => {
    const result = applySourceMetadata({
      author: '旧作者',
      description: '旧简介',
      publicationStatus: 'completed',
      sourceUrl: '',
      tags: ['本地上传', '百合'],
      title: '中文译名',
    }, sourceMetadata);

    expect(result).toEqual({
      author: '犬甘あんず',
      description: '原作简介',
      publicationStatus: 'ongoing',
      sourceUrl: sourceMetadata.source_url,
      tags: ['本地上传', '百合', '恋爱'],
      title: '中文译名',
    });
  });

  it('formats only available source statistics', () => {
    expect(getSourceMetadataStats(sourceMetadata)).toBe('39 话 · 101,234 字 · 连载中');
    expect(getSourceMetadataStats({ ...sourceMetadata, character_count: 0, episode_count: 0 })).toBe('连载中');
  });

  it('never imports Japanese description or tags when AI translation is unavailable', () => {
    const result = applySourceMetadata({
      author: '旧作者',
      description: '中文简介',
      publicationStatus: 'completed',
      sourceUrl: '',
      tags: ['中文标签'],
      title: '中文译名',
    }, { ...sourceMetadata, translation_status: 'unavailable' as const });

    expect(result).toMatchObject({
      description: '中文简介',
      sourceUrl: sourceMetadata.source_url,
      tags: ['中文标签'],
      title: '中文译名',
    });
  });
});
