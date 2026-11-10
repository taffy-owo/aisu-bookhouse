import { matchesPastedJapaneseArticleSubmission, type PastedJapaneseArticleInput, type PastedJapaneseArticleSubmission } from './pastedJapaneseArticle';

export type JapaneseArticleDraft = { input: PastedJapaneseArticleInput; submission?: PastedJapaneseArticleSubmission };
const key = (scope: string) => `aisu-bookhouse:japanese-article-draft:${scope}`;

export function readJapaneseArticleDraft(scope: string): JapaneseArticleDraft | null {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(key(scope)) ?? 'null');
    const input = parsed?.input;
    if (!input || typeof input.content !== 'string'
      || ['title', 'author', 'sourceUrl'].some((field) => input[field] !== undefined && typeof input[field] !== 'string')) return null;
    const candidate = parsed.submission;
    const validSubmission = candidate && typeof candidate.requestId === 'string'
      && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(candidate.requestId)
      && typeof candidate.metadataSaved === 'boolean'
      && (!candidate.receipt || (typeof candidate.receipt.bookId === 'string' && typeof candidate.receipt.taskId === 'string'))
      && candidate.input && typeof candidate.input.content === 'string'
      && ['title', 'author', 'sourceUrl'].every((field) => candidate.input[field] === undefined || typeof candidate.input[field] === 'string')
      && matchesPastedJapaneseArticleSubmission(candidate, input);
    return { input, submission: validSubmission ? { ...candidate, completed: candidate.completed === true && Boolean(candidate.receipt) && candidate.metadataSaved } : undefined };
  } catch { return null; }
}

export function writeJapaneseArticleDraft(scope: string, draft: JapaneseArticleDraft): boolean {
  try {
    if (!Object.values(draft.input).some((value) => value?.trim())) window.sessionStorage.removeItem(key(scope));
    else window.sessionStorage.setItem(key(scope), JSON.stringify(draft));
    return true;
  } catch { return false; }
}
