export type JapaneseLayout = 'original' | 'readable';
export type JapaneseFuriganaMode = 'all' | 'off' | 'on-demand';
export type JapaneseTranslationMode = 'bilingual' | 'off';

const STORAGE_KEY = 'aisu-bookhouse:japanese-layouts';
const FURIGANA_STORAGE_KEY = 'aisu-bookhouse:japanese-furigana';
const TRANSLATION_STORAGE_KEY = 'aisu-bookhouse:japanese-translation';

export function readJapaneseLayout(bookId: string): JapaneseLayout {
  if (typeof window === 'undefined') {
    return 'readable';
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return stored[bookId] === 'original' ? 'original' : 'readable';
  } catch {
    return 'readable';
  }
}

export function saveJapaneseLayout(bookId: string, layout: JapaneseLayout): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    stored[bookId] = layout;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private browsing can block storage; the current reader state still works.
  }
}

export function readJapaneseFuriganaMode(bookId: string): JapaneseFuriganaMode {
  if (typeof window === 'undefined') {
    return 'on-demand';
  }
  try {
    const raw = window.localStorage.getItem(FURIGANA_STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const value = stored[bookId];
    return value === 'all' || value === 'off' ? value : 'on-demand';
  } catch {
    return 'on-demand';
  }
}

export function saveJapaneseFuriganaMode(bookId: string, mode: JapaneseFuriganaMode): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const raw = window.localStorage.getItem(FURIGANA_STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    stored[bookId] = mode;
    window.localStorage.setItem(FURIGANA_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The current reader state still works if persistent storage is blocked.
  }
}

export function readJapaneseTranslationMode(bookId: string): JapaneseTranslationMode {
  if (typeof window === 'undefined') return 'off';
  try {
    const raw = window.localStorage.getItem(TRANSLATION_STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return stored[bookId] === 'bilingual' ? 'bilingual' : 'off';
  } catch {
    return 'off';
  }
}

export function saveJapaneseTranslationMode(bookId: string, mode: JapaneseTranslationMode): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(TRANSLATION_STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    stored[bookId] = mode;
    window.localStorage.setItem(TRANSLATION_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The current reader state still works if persistent storage is blocked.
  }
}
