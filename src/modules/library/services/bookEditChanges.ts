import type { Book } from '../../books';
import type { BookUpdateInput } from '../../books/services/bookService';
import { getBookLanguageSetting } from '../../books/services/bookLanguagePreferences';

/** Leave untouched fields out of PATCH so background updates to those fields survive. */
export function getBookEditChanges(input: BookUpdateInput, initial: Book): BookUpdateInput {
  const previous: BookUpdateInput = {
    author: initial.author.trim(), description: initial.description.trim(), title: initial.title.trim(),
    language: getBookLanguageSetting(initial), publicationStatus: initial.publicationStatus ?? 'completed', rating: initial.rating ?? 0,
    seriesKind: initial.seriesKind?.trim() || null, seriesOrder: initial.seriesOrder ?? null, seriesTitle: initial.seriesTitle?.trim() || null,
    sourceUrl: initial.sourceUrl?.trim() || null,
    sourceEpisodeCount: initial.sourceEpisodeCount, sourceCharacterCount: initial.sourceCharacterCount,
    sourceScheduleLabel: initial.sourceScheduleLabel, sourceScheduleTime: initial.sourceScheduleTime,
    sourceScheduleTimezone: initial.sourceScheduleTimezone === 'Asia/Tokyo' ? 'Asia/Tokyo' : null,
    tags: [...new Set(initial.tags.map((tag) => tag.trim()).filter(Boolean))],
  };
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== undefined
    && JSON.stringify(value) !== JSON.stringify(previous[key as keyof BookUpdateInput]))) as BookUpdateInput;
}
