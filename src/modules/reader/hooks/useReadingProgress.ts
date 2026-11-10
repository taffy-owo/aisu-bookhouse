import { useCallback, useState } from 'react';
import type { ReadingProgress } from '../types/reader';

export function useReadingProgress(initialProgress: ReadingProgress | null) {
  const [progress, setProgress] = useState<ReadingProgress | null>(initialProgress);

  const updateProgress = useCallback((nextProgress: ReadingProgress) => {
    setProgress(nextProgress);
  }, []);

  const resetProgress = useCallback(() => {
    setProgress(null);
  }, []);

  return {
    progress,
    resetProgress,
    updateProgress,
  };
}
