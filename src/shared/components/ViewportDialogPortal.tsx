import { createPortal } from 'react-dom';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn';
import { useDialogViewport } from '../hooks/useDialogViewport';

interface ViewportDialogPortalProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/**
 * Renders app dialogs at document.body so transformed or animated page
 * containers can never turn position: fixed into page-relative positioning.
 */
export function ViewportDialogPortal({ children, className, ...props }: ViewportDialogPortalProps) {
  const viewportRef = useDialogViewport();
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={cn(
        'viewport-dialog fixed isolate overflow-y-auto overscroll-contain',
        'px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-4',
        className,
      )}
      {...props}
      ref={viewportRef}
    >
      {children}
    </div>,
    document.body,
  );
}
