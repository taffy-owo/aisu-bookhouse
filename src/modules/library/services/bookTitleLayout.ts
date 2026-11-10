export function getBookTitleLayoutClass(title: string): string {
  const characterCount = Array.from(title.trim()).length;

  if (characterCount > 42) {
    return 'text-2xl leading-[1.24] sm:text-[1.75rem] lg:text-[2rem]';
  }

  if (characterCount > 28) {
    return 'text-[1.75rem] leading-[1.18] sm:text-[2rem] lg:text-[2.25rem]';
  }

  if (characterCount > 14) {
    return 'text-3xl leading-[1.12] sm:text-[2.25rem] lg:text-[2.5rem]';
  }

  return 'text-3xl leading-[1.08] sm:text-[2.5rem] lg:text-5xl';
}
