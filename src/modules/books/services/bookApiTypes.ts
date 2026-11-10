import type { BookKind, BookLanguage, BookPublicationStatus, BookPublicStatus, BookStatus, ReaderType } from '../types/book';

export type BackendBook = {
  author: string;
  cover_url: string | null;
  created_at: string;
  current_chapter: string | null;
  description: string;
  favorite: boolean;
  disliked: boolean;
  file_ext: string | null;
  file_size: number | null;
  hero_image_url: string | null;
  id: string;
  is_owned: boolean;
  kind: BookKind;
  language: BookLanguage;
  language_mode?: 'auto' | 'manual';
  mime_type: string | null;
  progress_percent: number;
  publication_status: BookPublicationStatus;
  auto_translate_updates?: boolean;
  public_approved_at: string | null;
  public_download_allowed: boolean;
  public_rejected_at: string | null;
  public_requested_at: string | null;
  public_share_note: string | null;
  public_source_note: string | null;
  public_status: BookPublicStatus;
  rating: number;
  reader_type: ReaderType;
  readers_label: string;
  series_kind: string | null;
  series_order: number | null;
  series_title: string | null;
  source_url: string | null;
  source_episode_count: number | null;
  source_character_count: number | null;
  source_update_count: number;
  source_checked_at: string | null;
  source_check_error: string | null;
  source_schedule_time: string | null;
  source_schedule_timezone: string | null;
  source_schedule_label: string | null;
  status: BookStatus;
  subtitle: string | null;
  tags: string[];
  title: string;
  updated_at: string;
  last_read_at?: string | null;
  version?: string | null;
  owner_id: string;
  owner_nickname: string | null;
  comment_count: number;
  chapter_count: number;
  page_count: number;
  character_count: number;
  asset_count: number;
  last_content_updated_at: string | null;
};

export type BackendBookListResponse = {
  has_more?: boolean;
  items: BackendBook[];
  page?: number;
  page_size?: number;
  total: number;
};

export type BackendBookShelfOverview = {
  ongoing_count?: number;
  source_update_count?: number;
  updated_items?: BackendBook[];
  book_labels: Array<{ id: string; title: string }>;
  continue_book: BackendBook | null;
  favorite_count: number;
  finished_count: number;
  in_progress_count: number;
  items: BackendBook[];
  total: number;
};

export type BackendSourceUpdateNotificationList = {
  book_count: number;
  episode_count: number;
  items: BackendBook[];
};
