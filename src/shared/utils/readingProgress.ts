/** Keep the display's unread/finished boundaries consistent with saved progress. */
export function normalizeReadingProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function formatReadingProgressPercent(value: number): string {
  const progress = normalizeReadingProgress(value);
  if (progress >= 100) return '100%';
  if (progress > 0 && progress < 1) return '<1%';
  return `${Math.min(99, Math.round(progress))}%`;
}
