import type { WorkSourceMetadata } from '../../uploads/services/sourceMetadataService';

export type EditableSourceMetadata = {
  author: string;
  description: string;
  publicationStatus: 'ongoing' | 'completed';
  sourceUrl: string;
  tags: string[];
  title: string;
};

export function applySourceMetadata(
  current: EditableSourceMetadata,
  metadata: WorkSourceMetadata,
): EditableSourceMetadata {
  const canImportTranslatedText = metadata.translation_status !== 'unavailable';
  return {
    author: metadata.author.trim() || current.author,
    description: canImportTranslatedText ? (metadata.description.trim() || current.description) : current.description,
    publicationStatus: metadata.publication_status,
    sourceUrl: metadata.source_url,
    tags: canImportTranslatedText
      ? Array.from(new Set([...current.tags, ...metadata.tags].map((tag) => tag.trim()).filter(Boolean))).slice(0, 50)
      : current.tags,
    // Uploaded EPUBs are often translated and already have a curated Chinese title.
    title: current.title,
  };
}

export function getSourceMetadataStats(metadata: WorkSourceMetadata): string {
  const stats: string[] = [];
  if (metadata.episode_count > 0) stats.push(`${metadata.episode_count.toLocaleString()} 话`);
  if (metadata.character_count > 0) stats.push(`${metadata.character_count.toLocaleString()} 字`);
  stats.push(metadata.publication_status === 'completed' ? '已完结' : '连载中');
  return stats.join(' · ');
}
