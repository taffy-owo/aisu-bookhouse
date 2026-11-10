import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INSTANT_AUDIOBOOK_PREFERENCES,
  readAudiobookMode,
  readInstantAudiobookPreferences,
  readInstantAudiobookProgress,
  saveAudiobookMode,
  saveInstantAudiobookPreferences,
  saveInstantAudiobookProgress,
} from './audiobookPreferences';

describe('audiobookPreferences', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('defaults to quality playback and persists an explicit instant choice', () => {
    expect(readAudiobookMode()).toBe('quality');
    saveAudiobookMode('instant');
    expect(readAudiobookMode()).toBe('instant');
  });

  it('persists instant playback controls', () => {
    const preferences = { autoAdvance: false, followText: false, playbackRate: 1.5, voiceUri: 'voice-1' } as const;
    saveInstantAudiobookPreferences(preferences);
    expect(readInstantAudiobookPreferences()).toEqual(preferences);
  });

  it('falls back from malformed controls and keeps per-book positions separate', () => {
    window.localStorage.setItem('aisu-bookhouse:instant-audiobook-preferences', '{bad');
    expect(readInstantAudiobookPreferences()).toEqual(DEFAULT_INSTANT_AUDIOBOOK_PREFERENCES);
    saveInstantAudiobookProgress('book-1', { chapterIndex: 3, segmentIndex: 7 });
    expect(readInstantAudiobookProgress('book-1')).toMatchObject({ chapterIndex: 3, segmentIndex: 7 });
    expect(readInstantAudiobookProgress('book-2')).toBeNull();
  });
});
