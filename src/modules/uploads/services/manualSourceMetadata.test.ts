import { describe, expect, it } from 'vitest';
import { EMPTY_MANUAL_BOOK_DRAFT, type ManualBookDraft } from './manualBookDraft';
import { mergeManualSourceMetadata } from './manualSourceMetadata';
import type { WorkSourceMetadata } from './sourceMetadataService';

const url = 'https://kakuyomu.jp/works/1';
const draft: ManualBookDraft = { ...EMPTY_MANUAL_BOOK_DRAFT, sourceUrl: url, content: '我的正文', title: '初始书名' };
const metadata: WorkSourceMetadata = { author: '来源作者', character_count: 100, cover_url: null, description: '来源简介',
  episode_count: 2, publication_status: 'ongoing', source: 'kakuyomu', source_url: url + '/', tags: ['标签一', '标签二'], title: '来源书名', translation_status: 'translated' };

describe('manual source metadata merging', () => {
  it('fills untouched metadata and normalizes the source without modifying article text', () => {
    expect(mergeManualSourceMetadata(draft, { ...draft }, url, metadata)).toMatchObject({ author: metadata.author,
      title: metadata.title, description: metadata.description, tags: '标签一，标签二', sourceUrl: metadata.source_url,
      publicationStatus: 'ongoing', content: draft.content });
  });

  it('preserves a newer title while filling untouched fields', () => {
    const current = { ...draft, title: '我刚编辑的书名' };
    expect(mergeManualSourceMetadata(current, draft, url, metadata)).toMatchObject({ title: current.title, author: metadata.author });
  });

  it('preserves each independently edited metadata field', () => {
    const current = { ...draft, author: '新作者', description: '新简介', tags: '新标签', publicationStatus: 'ongoing' as const };
    expect(mergeManualSourceMetadata(current, draft, url, { ...metadata, publication_status: 'completed' })).toMatchObject({
      author: current.author, description: current.description, tags: current.tags, publicationStatus: current.publicationStatus });
  });

  it('does not repopulate a cleared form after saving', () => {
    expect(mergeManualSourceMetadata(EMPTY_MANUAL_BOOK_DRAFT, draft, url, metadata)).toBe(EMPTY_MANUAL_BOOK_DRAFT);
  });

  it('ignores a response after the URL changes', () => {
    const current = { ...draft, sourceUrl: 'https://kakuyomu.jp/works/2' };
    expect(mergeManualSourceMetadata(current, draft, url, metadata)).toBe(current);
  });

  it('ignores a response after a submission reserves the draft', () => {
    const current = { ...draft, requestId: 'reserved-submission' };
    expect(mergeManualSourceMetadata(current, draft, url, metadata)).toBe(current);
  });

  it('keeps translated fields when source translation is unavailable', () => {
    const snapshot = { ...draft, description: '中文简介', tags: '中文标签' };
    expect(mergeManualSourceMetadata(snapshot, snapshot, url, { ...metadata, translation_status: 'unavailable' })).toMatchObject({
      title: snapshot.title, description: snapshot.description, tags: snapshot.tags, author: metadata.author });
  });

  it('accepts a pasted URL before the input change has committed', () => {
    const snapshot = { ...draft, sourceUrl: '' };
    expect(mergeManualSourceMetadata({ ...snapshot, sourceUrl: ' ' + url + ' ' }, snapshot, url, metadata).title).toBe(metadata.title);
  });
});
