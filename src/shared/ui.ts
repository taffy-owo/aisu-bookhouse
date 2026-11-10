export const HAIRLINE = 'border-hairline dark:border-white/10';
export const LABEL = 'text-[11px] uppercase tracking-[0.3em] text-ink/60 dark:text-stone-400';

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
