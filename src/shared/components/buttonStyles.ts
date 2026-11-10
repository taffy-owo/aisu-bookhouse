import { cn } from '../utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variantClass: Record<ButtonVariant, string> = {
  danger: 'font-medium bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-950/20 dark:text-red-400 dark:hover:bg-red-950/40',
  ghost: 'font-medium bg-transparent text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-night-soft dark:hover:bg-white/10 dark:hover:text-night-ink',
  // Filled controls keep solid white text for contrast on coral. Hover darkens
  // one step; disabled controls keep their resting color.
  primary:
    'font-semibold bg-accent-strong text-white shadow-[0_2px_6px_rgba(99,40,49,0.14)] hover:bg-accent-deep disabled:hover:bg-accent-strong',
  secondary:
    'font-medium bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-white/5 dark:text-night-copy dark:hover:bg-white/10',
};

export function getButtonClassName({ className, variant }: { className?: string; variant: ButtonVariant }) {
  return cn('inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 text-sm transition disabled:opacity-60', variantClass[variant], className);
}
