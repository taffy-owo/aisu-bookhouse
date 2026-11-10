import { cn } from '../utils/cn';
import { useTheme } from '../theme';
import { isLegacyDesktopShell } from '../desktopShell';

interface BrandMarkProps {
  className?: string;
  compact?: boolean;
}

/** Use the approved illustration; small headers use its simpler companion. */
export function BrandMark({ className, compact = false }: BrandMarkProps) {
  const { theme } = useTheme();
  const useLegacyArtwork = isLegacyDesktopShell();
  const src = useLegacyArtwork
    ? `/aisu-lily-${compact ? 'compact' : 'logo'}${theme === 'light' ? '-light' : ''}.png?v=20260910-daynight`
    : theme === 'light'
      ? '/aisu-brand-light.svg?v=20261018-vector'
      : '/aisu-brand.svg?v=20261018-vector';
  return (
    <img
      alt="爱素书屋"
      className={cn('brand-mark shrink-0', className)}
      decoding="async"
      height={96}
      width={96}
      src={src}
      data-compact={compact ? 'true' : undefined}
    />
  );
}
