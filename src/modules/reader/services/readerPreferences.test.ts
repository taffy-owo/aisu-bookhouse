import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_READER_PREFERENCES,
  getNextContentWidth,
  getNextFontScale,
  getNextLineHeight,
  getNextParagraphSpacing,
  readReaderPreferences,
  saveReaderPreferences,
} from './readerPreferences';

const STORAGE_KEY = 'aisu-bookhouse:reader-preferences';

describe('readerPreferences', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        clear: () => store.clear(),
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns defaults when no preference is saved', () => {
    expect(readReaderPreferences()).toEqual(DEFAULT_READER_PREFERENCES);
    expect(readReaderPreferences().textAlign).toBe('auto');
  });

  it.each(['auto', 'left', 'center', 'justify'] as const)('preserves the saved %s alignment choice', (textAlign) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ textAlign, theme: 'dark' }));
    expect(readReaderPreferences()).toMatchObject({ textAlign, theme: 'dark' });
  });

  it('saves and reads reader preferences', () => {
    saveReaderPreferences({
      chineseScript: 'simplified',
      contentWidth: 'wide',
      fontFamily: 'sans',
      fontScale: 'large',
      fontWeight: 'bold',
      lineHeight: 'loose',
      japaneseLayout: 'original',
      pagePadding: 'wide',
      paragraphSpacing: 'normal',
      pdfBrightness: 75,
      pdfTextFontSize: 24,
      readingMode: 'paged',
      tapToTurnPage: false,
      textAlign: 'center',
      textIndent: 'wide',
      theme: 'dark',
    });

    expect(readReaderPreferences()).toEqual({
      chineseScript: 'simplified',
      contentWidth: 'wide',
      fontFamily: 'sans',
      fontScale: 'large',
      fontWeight: 'bold',
      lineHeight: 'loose',
      japaneseLayout: 'original',
      pagePadding: 'wide',
      paragraphSpacing: 'normal',
      pdfBrightness: 75,
      pdfTextFontSize: 24,
      readingMode: 'paged',
      tapToTurnPage: false,
      textAlign: 'center',
      textIndent: 'wide',
      theme: 'dark',
    });
  });

  it('falls back cleanly when storage is blocked', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('storage blocked');
      },
    });

    expect(readReaderPreferences()).toEqual(DEFAULT_READER_PREFERENCES);
    expect(() => saveReaderPreferences(DEFAULT_READER_PREFERENCES)).not.toThrow();
  });

  it('normalizes invalid saved values', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        contentWidth: 'full',
        fontFamily: 'mono',
        fontScale: 'tiny',
        fontWeight: 'heavy',
        lineHeight: 'comfortable',
        pagePadding: 'huge',
        paragraphSpacing: 'none',
        textAlign: 'right',
        textIndent: 'giant',
        theme: 'blue',
      }),
    );

    expect(readReaderPreferences()).toEqual({
      ...DEFAULT_READER_PREFERENCES,
      lineHeight: 'comfortable',
    });
  });

  it('cycles reader preference controls', () => {
    expect(getNextFontScale('medium', 1)).toBe('large');
    expect(getNextFontScale('small', -1)).toBe('large');
    expect(getNextLineHeight('loose')).toBe('compact');
    expect(getNextContentWidth('wide')).toBe('narrow');
    expect(getNextParagraphSpacing('loose')).toBe('tight');
  });

  it('adds the PDF text size default without changing older typography choices', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontScale: 'large', fontFamily: 'sans', theme: 'dark' }));
    expect(readReaderPreferences()).toMatchObject({ fontScale: 'large', fontFamily: 'sans', theme: 'dark', pdfTextFontSize: 18 });
  });

  it.each([0, 100, 19, '20', null])('rejects an invalid saved PDF text size %j', (pdfTextFontSize) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ pdfTextFontSize, theme: 'dark' }));
    expect(readReaderPreferences()).toMatchObject({ pdfTextFontSize: 18, theme: 'dark' });
  });

  it.each(['serif', 'wenkai', 'song', 'sans'] as const)('keeps the %s reading font choice', (fontFamily) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontFamily }));

    expect(readReaderPreferences().fontFamily).toBe(fontFamily);
  });

  it.each([
    ['black', 'dark'],
    ['sakura', 'paper'],
  ])('migrates retired %s theme to %s', (storedTheme, expectedTheme) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontScale: 'large', theme: storedTheme }));

    expect(readReaderPreferences()).toMatchObject({ fontScale: 'large', theme: expectedTheme });
  });
});

describe('readingMode backward compatibility', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        clear: () => store.clear(),
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults readingMode to scroll for stored preferences that predate it', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'dark', fontScale: 'large' }));
    const preferences = readReaderPreferences();
    expect(preferences.readingMode).toBe('scroll');
    expect(preferences.tapToTurnPage).toBe(true);
    expect(preferences.theme).toBe('dark');
  });

  it('keeps a stored paged readingMode and rejects unknown values', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ readingMode: 'paged' }));
    expect(readReaderPreferences().readingMode).toBe('paged');

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ readingMode: 'diagonal' }));
    expect(readReaderPreferences().readingMode).toBe('scroll');
  });
});
