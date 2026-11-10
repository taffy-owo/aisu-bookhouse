import { describe, expect, it } from 'vitest';
import { isSameReaderNotePosition } from './readerNotePosition';
import type { ReaderMarkPositionInput } from '../types/reader';

describe('note draft location identity', () => {
  const prose: ReaderMarkPositionInput = { readerType: 'text', positionKey: 'chapter-1', chapterIndex: 1, epubCfi: 'aisu-scroll:0.1', progressPercent: 10 };
  it('detects a new position within the same prose chapter', () => {
    expect(isSameReaderNotePosition(prose, { ...prose, epubCfi: 'aisu-scroll:0.8' })).toBe(false);
    expect(isSameReaderNotePosition(prose, { ...prose, progressPercent: 11 })).toBe(true);
  });
  it('detects chapters even when legacy content has no position key', () => {
    const legacy = { ...prose, positionKey: undefined };
    expect(isSameReaderNotePosition(legacy, { ...legacy, chapterIndex: 2 })).toBe(false);
    const chapterOnly = { ...legacy, epubCfi: undefined };
    expect(isSameReaderNotePosition(chapterOnly, { ...chapterOnly, progressPercent: 20 })).toBe(false);
  });
  it('detects PDF and manga page changes within the same resource', () => {
    const pdf: ReaderMarkPositionInput = { readerType: 'pdf', positionKey: 'file', pageNumber: 1, progressPercent: 10 };
    expect(isSameReaderNotePosition(pdf, { ...pdf, pageNumber: 2 })).toBe(false);
    const manga: ReaderMarkPositionInput = { readerType: 'comic', positionKey: 'comic', imageIndex: 1, progressPercent: 10 };
    expect(isSameReaderNotePosition(manga, { ...manga, imageIndex: 2 })).toBe(false);
  });
  it('distinguishes file versions and uses percentage only when no locator exists', () => {
    expect(isSameReaderNotePosition(prose, { ...prose, positionKey: 'replaced' })).toBe(false);
    const legacy: ReaderMarkPositionInput = { readerType: 'text', progressPercent: 10 };
    expect(isSameReaderNotePosition(legacy, { ...legacy, progressPercent: 11 })).toBe(false);
    expect(isSameReaderNotePosition(legacy, { ...legacy })).toBe(true);
  });
});
