import type { Book } from '../types/book';

export function getBookLengthLabel(book: Book): string {
  if (book.kind === 'manga' || book.readerType === 'comic') {
    return getCountLabel(book.pageCount, '页', '漫画');
  }

  if (book.kind === 'pdf' || book.readerType === 'pdf') {
    return 'PDF';
  }

  if (book.kind === 'image' || book.readerType === 'image') {
    return getCountLabel(book.pageCount, '张', '图集');
  }

  const characters = book.characterCount ?? 0;
  if (characters >= 800000) {
    return '超长篇';
  }
  if (characters >= 250000) {
    return '长篇';
  }
  if (characters >= 60000) {
    return '中篇';
  }
  if (characters > 0) {
    return '短篇';
  }

  const chapters = book.chapterCount ?? 0;
  if (chapters >= 180) {
    return '超长篇';
  }
  if (chapters >= 70) {
    return '长篇';
  }
  if (chapters >= 20) {
    return '中篇';
  }
  if (chapters > 0) {
    return '短篇';
  }

  return '未解析';
}

export function getBookExtentLabel(book: Book): string {
  if (book.kind === 'manga' || book.readerType === 'comic') {
    return formatCount(book.pageCount, '页');
  }

  if (book.kind === 'image' || book.readerType === 'image') {
    return formatCount(book.pageCount, '张');
  }

  if (book.kind === 'pdf' || book.readerType === 'pdf') {
    return formatCount(book.pageCount, '页');
  }

  return [formatCharacterCount(book.characterCount), formatCount(book.chapterCount, '章')].filter(Boolean).join(' · ');
}

export function getPublicationStatusLabel(book: Book): string {
  return book.publicationStatus === 'ongoing' ? '连载中' : '已完结';
}

function getCountLabel(count: number | undefined, unit: string, fallback: string): string {
  return count && count > 0 ? `${count}${unit}` : fallback;
}

function formatCharacterCount(count: number | undefined): string {
  if (!count || count <= 0) {
    return '';
  }

  if (count >= 10000) {
    const value = count / 10000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}万字`;
  }

  return `${count.toLocaleString('zh-CN')}字`;
}

function formatCount(count: number | undefined, unit: string): string {
  return count && count > 0 ? `${count}${unit}` : '';
}
