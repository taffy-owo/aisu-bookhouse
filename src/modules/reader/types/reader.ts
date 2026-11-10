import type { ReaderType } from '../../books';

export type ReaderTheme = 'paper' | 'white' | 'green' | 'dark';

export type ReaderTocItem = {
  contentVersion?: string;
  positionKey?: string;
  index: number;
  level?: number;
  progressWeight?: number;
  sectionLevel?: number;
  sectionTitle?: string;
  title: string;
};

export type ReaderResource =
  | {
      chapterCount: number;
      readerType: Extract<ReaderType, 'epub' | 'text'>;
      toc: ReaderTocItem[];
      version?: string;
    }
  | {
      fileUrl?: string;
      /** Available after the current PDF document has loaded in the reader. */
      pageCount?: number;
      positionKey?: string;
      readerType: Extract<ReaderType, 'pdf'>;
      version?: string;
    }
  | {
      pageCount: number;
      pages: Array<{ index: number; imageUrl?: string; positionKey?: string }>;
      readerType: Extract<ReaderType, 'comic' | 'image'>;
      version?: string;
    }
  | {
      chapterCount: 0;
      readerType: Extract<ReaderType, 'unsupported'>;
      toc: [];
      version?: string;
    };

export type ReaderChapter = {
  contentVersion?: string;
  positionKey?: string;
  blocks?: ReaderChapterBlock[];
  content: string;
  index: number;
  title: string;
};

export type ReaderInlineMark = 'strong' | 'emphasis' | 'emphasis_dot';

export type ReaderInlineSpan = {
  marks?: ReaderInlineMark[];
  ruby?: string;
  text: string;
};

export type ReaderChapterBlock =
  | {
      spans?: ReaderInlineSpan[];
      text: string;
      type: 'paragraph';
    }
  | {
      level: number;
      spans?: ReaderInlineSpan[];
      text: string;
      type: 'heading';
    }
  | {
      alt?: string;
      imageHeight?: number;
      imageUrl?: string;
      imageWidth?: number;
      type: 'image';
    };

export type { ReadingProgress } from '../../reading-progress';

export type ReaderMarkKind = 'bookmark' | 'note';

export type ReaderMark = {
  contentVersion?: string;
  positionKey?: string;
  positionValid?: boolean;
  bookId: string;
  chapterIndex?: number;
  createdAt: string;
  epubCfi?: string;
  id: string;
  imageIndex?: number;
  kind: ReaderMarkKind;
  label: string;
  note: string;
  pageNumber?: number;
  progressPercent: number;
  readerType: ReaderType;
  updatedAt: string;
};

export type ReaderMarkCreateInput = {
  contentVersion?: string;
  positionKey?: string;
  chapterIndex?: number;
  epubCfi?: string;
  imageIndex?: number;
  kind: ReaderMarkKind;
  label: string;
  note?: string;
  pageNumber?: number;
  progressPercent: number;
  readerType: ReaderType;
};

export type ReaderMarkUpdateInput = {
  label?: string;
  note: string;
};

export type ReaderMarkPositionInput = Pick<ReaderMarkCreateInput, 'contentVersion' | 'positionKey' | 'readerType' | 'chapterIndex' | 'imageIndex' | 'pageNumber' | 'epubCfi' | 'progressPercent'>;
