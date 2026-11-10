import { useEffect, useLayoutEffect, useRef } from 'react';

let documentScrollLockCount = 0;
let restoreDocumentScroll: (() => void) | null = null;

function lockDocumentScroll() {
  documentScrollLockCount += 1;
  if (documentScrollLockCount > 1) return;

  const root = document.documentElement;
  const body = document.body;
  const scrollY = window.scrollY;
  const previous = {
    bodyLeft: body.style.left,
    bodyOverflow: body.style.overflow,
    bodyPaddingRight: body.style.paddingRight,
    bodyPosition: body.style.position,
    bodyRight: body.style.right,
    bodyTop: body.style.top,
    bodyWidth: body.style.width,
    rootOverflow: root.style.overflow,
  };
  const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);

  root.style.overflow = 'hidden';
  body.style.position = 'fixed';
  body.style.left = '0';
  body.style.right = '0';
  body.style.top = `-${scrollY}px`;
  body.style.width = '100%';
  body.style.overflow = 'hidden';
  if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

  restoreDocumentScroll = () => {
    root.style.overflow = previous.rootOverflow;
    body.style.position = previous.bodyPosition;
    body.style.left = previous.bodyLeft;
    body.style.right = previous.bodyRight;
    body.style.top = previous.bodyTop;
    body.style.width = previous.bodyWidth;
    body.style.overflow = previous.bodyOverflow;
    body.style.paddingRight = previous.bodyPaddingRight;
    window.scrollTo(0, scrollY);
  };
}

function unlockDocumentScroll() {
  documentScrollLockCount = Math.max(0, documentScrollLockCount - 1);
  if (documentScrollLockCount > 0) return;
  restoreDocumentScroll?.();
  restoreDocumentScroll = null;
}

const FOCUSABLE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  '[tabindex]',
].join(',');

interface DialogFocusEntry {
  dialog: HTMLElement;
  returnFocus: HTMLElement | null;
}

const activeDialogs: DialogFocusEntry[] = [];

function getFocusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0
      && !element.matches(':disabled')
      && !element.closest('[inert]')
      && element.getClientRects().length > 0
      && !['hidden', 'collapse'].includes(window.getComputedStyle(element).visibility));
}

/** Focuses, traps Tab inside, supports Escape, and restores the opener. */
export function useDialogFocus<TElement extends HTMLElement>(isOpen: boolean, onClose: () => void, canClose = true) {
  const dialogRef = useRef<TElement | null>(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);

  useEffect(() => {
    onCloseRef.current = onClose;
    canCloseRef.current = canClose;
  }, [canClose, onClose]);

  // Release the old page's scroll lock before the destination route restores
  // its position. Passive cleanup can otherwise overwrite the new route.
  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const entry: DialogFocusEntry = {
      dialog,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    activeDialogs.push(entry);
    lockDocumentScroll();
    const isTopDialog = () => activeDialogs.at(-1) === entry;
    const frame = window.requestAnimationFrame(() => {
      if (!isTopDialog() || dialog.contains(document.activeElement)) return;
      const items = getFocusableElements(dialog);
      // Delay initial focus until the opener has been recorded and scroll is locked.
      const initial = items.find((element) => element.hasAttribute('data-dialog-autofocus')) ?? items[0] ?? dialog;
      initial?.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape/Tab can belong to an IME candidate list or a child control.
      // Do not dismiss the draft or move focus while that input is active.
      if (!isTopDialog() || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (canCloseRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = getFocusableElements(dialog);
      if (items.length === 0) {
        event.preventDefault();
        dialog?.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      const activeIndex = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (activeIndex === -1 || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      const wasTopDialog = isTopDialog();
      activeDialogs.splice(activeDialogs.indexOf(entry), 1);
      // If a lower dialog disappears first, preserve its opener as the return
      // destination for dialogs that would otherwise restore a removed node.
      for (const remaining of activeDialogs) {
        if (remaining.returnFocus && dialog.contains(remaining.returnFocus)) remaining.returnFocus = entry.returnFocus;
      }
      unlockDocumentScroll();
      if (!wasTopDialog) return;
      const remaining = activeDialogs.at(-1)?.dialog;
      if (entry.returnFocus?.isConnected && (!remaining || remaining.contains(entry.returnFocus))) {
        entry.returnFocus.focus({ preventScroll: true });
      } else if (remaining) {
        (getFocusableElements(remaining)[0] ?? remaining).focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  return dialogRef;
}
