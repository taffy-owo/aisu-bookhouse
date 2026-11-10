import { apiRequest } from '../../../shared/api';

export type JapaneseLookupResult = {
  available: boolean;
  dictionaryForm?: string;
  englishGlosses: string[];
  query: string;
  reading?: string;
  translation?: string;
};

type BackendJapaneseLookupResult = {
  available: boolean;
  dictionary_form: string | null;
  english_glosses: string[];
  query: string;
  reading: string | null;
  translation: string | null;
};

export async function lookupJapaneseText(bookId: string | undefined, text: string, signal?: AbortSignal): Promise<JapaneseLookupResult> {
  const params = new URLSearchParams({ text: text.trim() });
  const path = bookId ? `/books/${bookId}/reader/japanese-lookup` : '/books/reader/japanese-lookup';
  const result = await apiRequest<BackendJapaneseLookupResult>(`${path}?${params.toString()}`, { signal });
  return {
    available: result.available,
    dictionaryForm: result.dictionary_form ?? undefined,
    englishGlosses: result.english_glosses,
    query: result.query,
    reading: result.reading ?? undefined,
    translation: result.translation ?? undefined,
  };
}
