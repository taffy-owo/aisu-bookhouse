export function findTextMatches(text: string, query: string): { start: number; end: number }[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  // Match in the original string. Lowercasing first can expand characters
  // (for example İ), shifting every subsequent highlight off its source.
  const literal = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(text.matchAll(new RegExp(literal, 'giu')), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function countTextMatches(text: string, query: string): number {
  return findTextMatches(text, query).length;
}

export function estimateReadingMinutes(text: string, charsPerMinute = 500): number {
  const characterCount = text.replace(/\s+/g, '').length;
  if (characterCount === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(characterCount / charsPerMinute));
}

export function formatReadingMinutes(minutes: number): string {
  if (minutes <= 0) {
    return '不足 1 分钟';
  }

  if (minutes < 60) {
    return `约 ${minutes} 分钟`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `约 ${hours} 小时 ${remainingMinutes} 分钟` : `约 ${hours} 小时`;
}
