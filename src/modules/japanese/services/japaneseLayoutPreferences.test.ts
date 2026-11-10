import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readJapaneseFuriganaMode,
  readJapaneseLayout,
  readJapaneseTranslationMode,
  saveJapaneseFuriganaMode,
  saveJapaneseLayout,
  saveJapaneseTranslationMode,
} from './japaneseLayoutPreferences';

describe('japaneseLayoutPreferences', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('defaults each book to readable and remembers overrides independently', () => {
    expect(readJapaneseLayout('a')).toBe('readable');
    saveJapaneseLayout('a', 'original');
    expect(readJapaneseLayout('a')).toBe('original');
    expect(readJapaneseLayout('b')).toBe('readable');
  });

  it('defaults furigana to on-demand and remembers it independently', () => {
    expect(readJapaneseFuriganaMode('a')).toBe('on-demand');
    saveJapaneseFuriganaMode('a', 'all');
    saveJapaneseFuriganaMode('b', 'off');
    expect(readJapaneseFuriganaMode('a')).toBe('all');
    expect(readJapaneseFuriganaMode('b')).toBe('off');
  });

  it('keeps bilingual translation opt-in per book', () => {
    expect(readJapaneseTranslationMode('a')).toBe('off');
    saveJapaneseTranslationMode('a', 'bilingual');
    expect(readJapaneseTranslationMode('a')).toBe('bilingual');
    expect(readJapaneseTranslationMode('b')).toBe('off');
  });
});
