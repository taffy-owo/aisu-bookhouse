import { PRODUCT_NAME } from '../../config/product';
import { cn } from '../utils/cn';
import { BrandMark } from './BrandMark';

interface BrandWordmarkProps {
  className?: string;
  compact?: boolean;
}

/** A crisp vector mark paired with the bookish wordmark used by the shell and auth surfaces. */
export function BrandWordmark({ className, compact = false }: BrandWordmarkProps) {
  return (
    <span className={cn('brand-wordmark', compact && 'brand-wordmark-compact', className)}>
      <BrandMark className={compact ? 'h-7 w-7' : 'h-10 w-10'} compact={compact} />
      <span className="brand-wordmark-copy">
        <span className="brand-wordmark-name">{PRODUCT_NAME}</span>
        {!compact && <span className="brand-wordmark-subtitle">READ · WRITE · KEEP</span>}
      </span>
    </span>
  );
}
