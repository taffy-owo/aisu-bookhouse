/** Browser selections include visible ruby readings; lookups need source text. */
export function getJapaneseSelectionText(range: Range, { includeTranslations = false }: { includeTranslations?: boolean } = {}): string {
  const excluded = includeTranslations ? 'rt, rp' : 'rt, rp, .reader-ai-translation';
  const ancestor = range.commonAncestorContainer;
  const element = ancestor instanceof Element ? ancestor : ancestor.parentElement;
  if (element?.closest(excluded)) return '';
  const fragment = range.cloneContents();
  for (const annotation of fragment.querySelectorAll(excluded)) annotation.remove();
  // Keep paragraph boundaries when selecting more than one source block.
  for (const breakElement of fragment.querySelectorAll('br')) breakElement.replaceWith('\n');
  for (const block of fragment.querySelectorAll('p, h1, h2, h3, h4, h5, h6')) block.append('\n');
  return (fragment.textContent ?? '').replace(/\n{3,}/gu, '\n\n').trim();
}
