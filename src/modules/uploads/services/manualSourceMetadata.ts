import type { ManualBookDraft } from './manualBookDraft';
import { sourceTranslationNotice, type WorkSourceMetadata } from './sourceMetadataService';

/** Fill only fields that still match the draft used to start the lookup. */
export function mergeManualSourceMetadata(current: ManualBookDraft, snapshot: ManualBookDraft, requestedUrl: string, metadata: WorkSourceMetadata): ManualBookDraft {
  if (current.sourceUrl.trim() !== requestedUrl.trim() || current.requestId !== snapshot.requestId) return current;
  const translated = metadata.translation_status !== 'unavailable';
  return {
    ...current,
    sourceUrl: metadata.source_url,
    author: current.author === snapshot.author ? metadata.author : current.author,
    publicationStatus: current.publicationStatus === snapshot.publicationStatus ? metadata.publication_status : current.publicationStatus,
    title: translated && current.title === snapshot.title ? metadata.title : current.title,
    description: translated && current.description === snapshot.description ? metadata.description : current.description,
    tags: translated && current.tags === snapshot.tags ? metadata.tags.join('，') : current.tags,
  };
}

export function manualSourceMetadataMessage(metadata: WorkSourceMetadata): string {
  const stats: string[] = [];
  if (metadata.episode_count > 0) stats.push(metadata.episode_count.toLocaleString() + ' 话');
  if (metadata.character_count > 0) stats.push(metadata.character_count.toLocaleString() + ' 字');
  stats.push(metadata.publication_status === 'completed' ? '已完结' : '连载中');
  const translationMessage = metadata.translation_status === 'translated' ? '，标题、简介和标签已自动翻译'
    : metadata.translation_status === 'unavailable' ? '，' + sourceTranslationNotice(metadata) : '';
  return '已读取 ' + stats.join(' · ') + translationMessage;
}
