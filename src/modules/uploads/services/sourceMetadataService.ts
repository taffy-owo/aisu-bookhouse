import { apiRequest } from '../../../shared/api';

export type WorkSourceMetadata = {
  author: string;
  character_count: number;
  cover_url: string | null;
  description: string;
  episode_count: number;
  publication_status: 'ongoing' | 'completed';
  source: 'hameln' | 'kakuyomu' | 'narou' | 'pixiv';
  source_url: string;
  tags: string[];
  title: string;
  schedule_label?: string | null;
  schedule_time?: string | null;
  schedule_timezone?: string | null;
  episodes?: Array<{
    index: number;
    section_level: number;
    section_title: string | null;
    title: string;
    url: string;
  }>;
  original_title?: string | null;
  translation_status?: 'not_needed' | 'translated' | 'unavailable';
  translation_error_code?: string | null;
  translation_error_message?: string | null;
  translation_channel?: string | null;
  translation_model?: string | null;
};

export function sourceTranslationNotice(metadata: WorkSourceMetadata): string {
  if (metadata.translation_status !== 'unavailable') return '';
  const provider = [metadata.translation_channel, metadata.translation_model].filter(Boolean).join(' · ');
  const reason = metadata.translation_error_message || '资料翻译暂不可用，请检查渠道设置';
  return `${provider ? `${provider}：` : ''}${reason}。未用日文资料覆盖书籍。`;
}

export async function getWorkSourceMetadata(url: string, signal?: AbortSignal): Promise<WorkSourceMetadata> {
  return apiRequest<WorkSourceMetadata>('/uploads/source-metadata', {
    body: JSON.stringify({ url }),
    method: 'POST',
    signal,
  });
}

export function looksLikeSupportedSourceLink(value: string): boolean {
  return /(?:kakuyomu\.jp\/works\/|(?:ncode|novel18)\.syosetu\.com\/|syosetu\.org\/novel\/|pixiv\.net\/(?:[a-z]{2}\/)?novel\/)/i.test(value);
}
