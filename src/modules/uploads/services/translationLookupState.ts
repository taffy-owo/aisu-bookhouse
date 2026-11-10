import { looksLikeSupportedSourceLink } from './sourceMetadataService';

export interface TranslationLookupState {
  /** Controller for the newest in-flight catalogue lookup. */
  controller: AbortController | null;
  /** The URL whose lookup has already been dispatched or resolved. */
  requested: string;
  /** Monotonic id of the newest dispatched lookup. */
  sequence: number;
}

export const createTranslationLookupState = (): TranslationLookupState => ({ controller: null, requested: '', sequence: 0 });

/**
 * Decide whether a URL still needs a catalogue lookup.
 *
 * Resolving a link rewrites the field with the server's normalised URL, which
 * used to feed straight back into the debounce effect and fire a second
 * identical request -- the spinner appeared, stopped, then started again.
 */
export const shouldRequestTranslationLookup = (
  url: string,
  state: TranslationLookupState,
  mode: 'file' | 'translation' | 'manual',
): boolean => {
  if (mode !== 'translation') return false;
  const trimmed = url.trim();
  if (!trimmed || !looksLikeSupportedSourceLink(trimmed)) return false;
  return trimmed !== state.requested;
};

/**
 * Only the newest lookup may write results or clear the spinner; an older
 * response landing late must not overwrite the URL the reader has since typed.
 */
export const isLatestTranslationLookup = (sequence: number, state: TranslationLookupState): boolean =>
  sequence === state.sequence;
