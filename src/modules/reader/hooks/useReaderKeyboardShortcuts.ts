import { useEffect } from 'react';
import { shouldIgnoreReaderKeyboardEvent } from '../services/readerKeyboard';

interface ReaderKeyboardShortcutsOptions {
  disabled?: boolean;
  onArrowLeft?: () => void;
  onArrowRight?: () => void;
  /** Space / PageDown — page forward (paged mode). */
  onPageDown?: () => void;
  /** Shift+Space / PageUp — page back (paged mode). */
  onPageUp?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

export function useReaderKeyboardShortcuts({ disabled = false, onArrowLeft, onArrowRight, onPageDown, onPageUp, onZoomIn, onZoomOut, onZoomReset }: ReaderKeyboardShortcutsOptions) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (disabled || shouldIgnoreReaderKeyboardEvent(event)) {
        return;
      }

      if (event.key === 'ArrowLeft' && onArrowLeft) {
        event.preventDefault();
        onArrowLeft();
      }

      if (event.key === 'ArrowRight' && onArrowRight) {
        event.preventDefault();
        onArrowRight();
      }

      if (onPageDown && (event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey))) {
        event.preventDefault();
        onPageDown();
      }

      if (onPageUp && (event.key === 'PageUp' || (event.key === ' ' && event.shiftKey))) {
        event.preventDefault();
        onPageUp();
      }

      if ((event.key === '+' || event.key === '=') && onZoomIn) {
        event.preventDefault();
        onZoomIn();
      }

      if (event.key === '-' && onZoomOut) {
        event.preventDefault();
        onZoomOut();
      }

      if (event.key === '0' && onZoomReset) {
        event.preventDefault();
        onZoomReset();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [disabled, onArrowLeft, onArrowRight, onPageDown, onPageUp, onZoomIn, onZoomOut, onZoomReset]);
}
