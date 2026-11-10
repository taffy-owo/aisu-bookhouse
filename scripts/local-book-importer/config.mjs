import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Source directory for the local importer. Pass a path as the first CLI argument,
// set AISU_IMPORT_SOURCE_DIR, or drop books into <project>/local-books.
export const DEFAULT_SOURCE_DIR = process.env.AISU_IMPORT_SOURCE_DIR || path.join(PROJECT_ROOT, 'local-books');
export const DEFAULT_OUTPUT_FILE = path.join(PROJECT_ROOT, 'src/modules/books/data/localImportedBooks.ts');
export const IMPORTED_COVER_DIR = path.join(PROJECT_ROOT, 'public/assets/imported-covers');
export const IMPORTED_COVER_URL_PREFIX = '/assets/imported-covers';

export const FORMAT_META = new Map([
  ['.azw3', { fileLabel: 'AZW3', kind: 'novel', readerType: 'epub' }],
  ['.cbr', { fileLabel: 'CBR', kind: 'manga', readerType: 'comic' }],
  ['.cbz', { fileLabel: 'CBZ', kind: 'manga', readerType: 'comic' }],
  ['.epub', { fileLabel: 'EPUB', kind: 'novel', readerType: 'epub' }],
  ['.jpeg', { fileLabel: 'JPEG', kind: 'image', readerType: 'image' }],
  ['.jpg', { fileLabel: 'JPG', kind: 'image', readerType: 'image' }],
  ['.mobi', { fileLabel: 'MOBI', kind: 'novel', readerType: 'epub' }],
  ['.pdf', { fileLabel: 'PDF', kind: 'pdf', readerType: 'pdf' }],
  ['.png', { fileLabel: 'PNG', kind: 'image', readerType: 'image' }],
  ['.rar', { fileLabel: 'RAR', kind: 'manga', readerType: 'comic' }],
  ['.txt', { fileLabel: 'TXT', kind: 'novel', readerType: 'text' }],
  ['.webp', { fileLabel: 'WEBP', kind: 'image', readerType: 'image' }],
  ['.zip', { fileLabel: 'ZIP', kind: 'manga', readerType: 'comic' }],
]);
