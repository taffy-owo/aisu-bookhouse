const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const SAME_YEAR_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'long',
});
const FULL_DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'long',
  year: 'numeric',
});
const ISO_WITHOUT_TIME_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function parseAppDate(dateText: string): Date {
  const normalizedDateText = ISO_WITHOUT_TIME_ZONE_PATTERN.test(dateText) ? `${dateText}Z` : dateText;

  return new Date(normalizedDateText);
}

/** Compare database timestamps without dropping precision below milliseconds. */
export function compareAppTimestamps(first: string, second: string): number {
  const milliseconds = parseAppDate(first).getTime() - parseAppDate(second).getTime();
  if (milliseconds !== 0) return milliseconds;
  const remainder = (value: string) => (value.match(/T\d{2}:\d{2}:\d{2}\.(\d+)/u)?.[1].slice(3) ?? '').padEnd(6, '0');
  const left = remainder(first), right = remainder(second);
  return left === right ? 0 : left > right ? 1 : -1;
}

export function formatDate(dateText: string): string {
  const date = parseAppDate(dateText);

  if (Number.isNaN(date.getTime())) {
    return dateText;
  }

  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMinutes = Math.round(diffMs / 60_000);
  const diffHours = Math.round(diffMs / 3_600_000);
  const diffDays = Math.round(diffMs / 86_400_000);

  if (Math.abs(diffMinutes) < 1) {
    return '刚刚';
  }

  if (Math.abs(diffMinutes) < 60) {
    return RELATIVE_TIME_FORMATTER.format(diffMinutes, 'minute');
  }

  if (Math.abs(diffHours) < 24) {
    return RELATIVE_TIME_FORMATTER.format(diffHours, 'hour');
  }

  if (Math.abs(diffDays) <= 7) {
    return RELATIVE_TIME_FORMATTER.format(diffDays, 'day');
  }

  if (date.getFullYear() === now.getFullYear()) {
    return SAME_YEAR_FORMATTER.format(date);
  }

  return FULL_DATE_FORMATTER.format(date);
}
