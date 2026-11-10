export type AudiobookMode = 'instant' | 'quality';

export type InstantAudiobookPreferences = {
  autoAdvance: boolean;
  followText: boolean;
  playbackRate: number;
  voiceUri: string;
};

export type InstantAudiobookProgress = {
  chapterIndex: number;
  segmentIndex: number;
  updatedAt: string;
};

const MODE_STORAGE_KEY = 'aisu-bookhouse:audiobook-mode';
const PREFERENCES_STORAGE_KEY = 'aisu-bookhouse:instant-audiobook-preferences';
const PROGRESS_STORAGE_PREFIX = 'aisu-bookhouse:instant-audiobook-progress:';

export const DEFAULT_INSTANT_AUDIOBOOK_PREFERENCES: InstantAudiobookPreferences = {
  autoAdvance: true,
  followText: true,
  playbackRate: 1,
  voiceUri: '',
};

export function readAudiobookMode(): AudiobookMode {
  // Free Edge TTS is the default quality path. Keep an explicit instant
  // choice for users who prefer device speech or need immediate playback.
  return readStorage(MODE_STORAGE_KEY) === 'instant' ? 'instant' : 'quality';
}

export function saveAudiobookMode(mode: AudiobookMode): void {
  writeStorage(MODE_STORAGE_KEY, mode);
}

export function readInstantAudiobookPreferences(): InstantAudiobookPreferences {
  const raw = readStorage(PREFERENCES_STORAGE_KEY);
  if (!raw) return DEFAULT_INSTANT_AUDIOBOOK_PREFERENCES;
  try {
    const value = JSON.parse(raw) as Partial<InstantAudiobookPreferences>;
    return {
      autoAdvance: typeof value.autoAdvance === 'boolean' ? value.autoAdvance : true,
      followText: typeof value.followText === 'boolean' ? value.followText : true,
      playbackRate: typeof value.playbackRate === 'number' && [0.8, 1, 1.2, 1.5, 2].includes(value.playbackRate) ? value.playbackRate : 1,
      voiceUri: typeof value.voiceUri === 'string' ? value.voiceUri : '',
    };
  } catch {
    return DEFAULT_INSTANT_AUDIOBOOK_PREFERENCES;
  }
}

export function saveInstantAudiobookPreferences(preferences: InstantAudiobookPreferences): void {
  writeStorage(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
}

export function readInstantAudiobookProgress(bookId: string): InstantAudiobookProgress | null {
  const raw = readStorage(`${PROGRESS_STORAGE_PREFIX}${bookId}`);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<InstantAudiobookProgress>;
    if (!Number.isInteger(value.chapterIndex) || Number(value.chapterIndex) < 1 || !Number.isInteger(value.segmentIndex) || Number(value.segmentIndex) < 0) return null;
    return {
      chapterIndex: Number(value.chapterIndex),
      segmentIndex: Number(value.segmentIndex),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveInstantAudiobookProgress(bookId: string, progress: Omit<InstantAudiobookProgress, 'updatedAt'>): void {
  writeStorage(`${PROGRESS_STORAGE_PREFIX}${bookId}`, JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }));
}

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing or hardened storage can reject writes; playback still works.
  }
}
