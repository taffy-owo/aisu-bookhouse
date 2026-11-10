import type { ReaderTheme } from '../types/reader';

export type ReaderPreferences = {
  chineseScript: 'original' | 'simplified';
  contentWidth: 'narrow' | 'comfortable' | 'wide';
  fontFamily: 'serif' | 'wenkai' | 'song' | 'sans';
  fontScale: 'small' | 'medium' | 'large';
  fontWeight: 'regular' | 'medium' | 'bold';
  lineHeight: 'compact' | 'comfortable' | 'loose';
  japaneseLayout: 'original' | 'readable';
  pagePadding: 'compact' | 'comfortable' | 'wide';
  paragraphSpacing: 'tight' | 'normal' | 'loose';
  pdfBrightness: number;
  pdfTextFontSize: number;
  readingMode: 'scroll' | 'paged';
  tapToTurnPage: boolean;
  textAlign: 'auto' | 'left' | 'center' | 'justify';
  textIndent: 'none' | 'normal' | 'wide';
  theme: ReaderTheme;
};

const READER_PREFERENCES_STORAGE_KEY = 'aisu-bookhouse:reader-preferences';
const READER_THEME_VALUES: ReaderTheme[] = ['dark', 'green', 'paper', 'white'];

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  chineseScript: 'original',
  contentWidth: 'comfortable',
  fontFamily: 'serif',
  fontScale: 'medium',
  fontWeight: 'regular',
  lineHeight: 'comfortable',
  japaneseLayout: 'readable',
  pagePadding: 'comfortable',
  paragraphSpacing: 'normal',
  pdfBrightness: 100,
  pdfTextFontSize: 18,
  readingMode: 'scroll',
  tapToTurnPage: true,
  textAlign: 'auto',
  textIndent: 'normal',
  theme: 'paper',
};

export function readReaderPreferences(): ReaderPreferences {
  if (typeof window === 'undefined') {
    return DEFAULT_READER_PREFERENCES;
  }

  const rawPreferences = readStoredPreferences();
  if (!rawPreferences) {
    return DEFAULT_READER_PREFERENCES;
  }

  try {
    return normalizeReaderPreferences(JSON.parse(rawPreferences));
  } catch {
    return DEFAULT_READER_PREFERENCES;
  }
}

export function saveReaderPreferences(preferences: ReaderPreferences): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    getReaderPreferenceStorage()?.setItem(READER_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Hardened/private browser modes can reject storage writes; reading still works for this session.
  }
}

export function getNextFontScale(current: ReaderPreferences['fontScale'], direction: 1 | -1): ReaderPreferences['fontScale'] {
  return getNextValue(['small', 'medium', 'large'], current, direction);
}

export function getNextLineHeight(current: ReaderPreferences['lineHeight']): ReaderPreferences['lineHeight'] {
  return getNextValue(['compact', 'comfortable', 'loose'], current, 1);
}

export function getNextContentWidth(current: ReaderPreferences['contentWidth']): ReaderPreferences['contentWidth'] {
  return getNextValue(['narrow', 'comfortable', 'wide'], current, 1);
}

export function getNextParagraphSpacing(current: ReaderPreferences['paragraphSpacing']): ReaderPreferences['paragraphSpacing'] {
  return getNextValue(['tight', 'normal', 'loose'], current, 1);
}

function normalizeReaderPreferences(input: unknown): ReaderPreferences {
  const preferences = typeof input === 'object' && input !== null ? (input as Partial<ReaderPreferences>) : {};

  return {
    chineseScript: isOneOf(preferences.chineseScript, ['original', 'simplified']) ? preferences.chineseScript : DEFAULT_READER_PREFERENCES.chineseScript,
    contentWidth: isOneOf(preferences.contentWidth, ['narrow', 'comfortable', 'wide']) ? preferences.contentWidth : DEFAULT_READER_PREFERENCES.contentWidth,
    fontFamily: isOneOf(preferences.fontFamily, ['serif', 'wenkai', 'song', 'sans']) ? preferences.fontFamily : DEFAULT_READER_PREFERENCES.fontFamily,
    fontScale: isOneOf(preferences.fontScale, ['small', 'medium', 'large']) ? preferences.fontScale : DEFAULT_READER_PREFERENCES.fontScale,
    fontWeight: isOneOf(preferences.fontWeight, ['regular', 'medium', 'bold']) ? preferences.fontWeight : DEFAULT_READER_PREFERENCES.fontWeight,
    lineHeight: isOneOf(preferences.lineHeight, ['compact', 'comfortable', 'loose']) ? preferences.lineHeight : DEFAULT_READER_PREFERENCES.lineHeight,
    japaneseLayout: isOneOf(preferences.japaneseLayout, ['original', 'readable']) ? preferences.japaneseLayout : DEFAULT_READER_PREFERENCES.japaneseLayout,
    pagePadding: isOneOf(preferences.pagePadding, ['compact', 'comfortable', 'wide']) ? preferences.pagePadding : DEFAULT_READER_PREFERENCES.pagePadding,
    paragraphSpacing: isOneOf(preferences.paragraphSpacing, ['tight', 'normal', 'loose']) ? preferences.paragraphSpacing : DEFAULT_READER_PREFERENCES.paragraphSpacing,
    pdfBrightness: typeof preferences.pdfBrightness === 'number' && preferences.pdfBrightness >= 50 && preferences.pdfBrightness <= 100 ? preferences.pdfBrightness : DEFAULT_READER_PREFERENCES.pdfBrightness,
    pdfTextFontSize: typeof preferences.pdfTextFontSize === 'number' && [16, 18, 20, 22, 24, 26].includes(preferences.pdfTextFontSize) ? preferences.pdfTextFontSize : DEFAULT_READER_PREFERENCES.pdfTextFontSize,
    readingMode: isOneOf(preferences.readingMode, ['scroll', 'paged']) ? preferences.readingMode : DEFAULT_READER_PREFERENCES.readingMode,
    tapToTurnPage: typeof preferences.tapToTurnPage === 'boolean' ? preferences.tapToTurnPage : DEFAULT_READER_PREFERENCES.tapToTurnPage,
    textAlign: isOneOf(preferences.textAlign, ['auto', 'left', 'center', 'justify']) ? preferences.textAlign : DEFAULT_READER_PREFERENCES.textAlign,
    textIndent: isOneOf(preferences.textIndent, ['none', 'normal', 'wide']) ? preferences.textIndent : DEFAULT_READER_PREFERENCES.textIndent,
    theme: normalizeReaderTheme(preferences.theme),
  };
}

function normalizeReaderTheme(value: unknown): ReaderTheme {
  // Migrate retired themes without discarding the user's typography choices.
  if (value === 'black') return 'dark';
  if (value === 'sakura') return 'paper';
  return isOneOf(value, READER_THEME_VALUES) ? value : DEFAULT_READER_PREFERENCES.theme;
}

function getReaderPreferenceStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStoredPreferences(): string | null {
  try {
    return getReaderPreferenceStorage()?.getItem(READER_PREFERENCES_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function getNextValue<TValue extends string>(values: TValue[], current: TValue, direction: 1 | -1): TValue {
  const currentIndex = values.indexOf(current);
  const nextIndex = (currentIndex + direction + values.length) % values.length;
  return values[nextIndex];
}

function isOneOf<TValue extends string>(value: unknown, values: TValue[]): value is TValue {
  return typeof value === 'string' && values.includes(value as TValue);
}
