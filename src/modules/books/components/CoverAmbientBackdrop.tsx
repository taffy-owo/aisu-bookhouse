import { useState } from 'react';
import { useAuthenticatedImageResource } from '../../../shared/hooks/useAuthenticatedImageUrl';
import { cn } from '../../../shared/utils/cn';
import { getBookCoverUrl } from '../services/bookCoverUrl';

interface CoverAmbientBackdropProps {
  className?: string;
  coverUrl?: string;
}

/**
 * Blurred, desaturated echo of a book cover behind a paper wash, so each
 * book tints its own page. Pure CSS over the cached cover blob — no color
 * extraction. Falls back to plain paper when there is no cover.
 */
export function CoverAmbientBackdrop({ className, coverUrl }: CoverAmbientBackdropProps) {
  const image = useAuthenticatedImageResource(getBookCoverUrl(coverUrl, 'large'));
  const imageUrl = image.url;
  const [loadedUrl, setLoadedUrl] = useState<string>();

  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 select-none overflow-hidden', className)}>
      {imageUrl && (
        <img
          key={imageUrl}
          alt=""
          className={cn(
            'absolute inset-0 h-full w-full scale-[2.5] object-cover blur-[60px] saturate-[.72] transition-opacity duration-1000 ease-out',
            loadedUrl === imageUrl ? 'opacity-50 dark:opacity-20' : 'opacity-0',
          )}
          decoding="async"
          draggable={false}
          onError={image.onError}
          onLoad={() => setLoadedUrl(imageUrl)}
          src={imageUrl}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-paper/25 via-paper/10 to-paper dark:from-night/40 dark:via-night/25 dark:to-night" />
    </div>
  );
}
