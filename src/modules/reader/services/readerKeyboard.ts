const CONTROL_SELECTOR = [
  'a', 'button', 'input', 'textarea', 'select', 'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]', '[role="link"]', '[role="textbox"]',
  '[role="combobox"]', '[role="slider"]', '[role="spinbutton"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[role="tab"]', '[role="menuitem"]', '[role="option"]',
  '.reader-toc-panel', '[data-reader-no-shortcuts]',
].join(',');

/** Reader shortcuts must not replace editing, selection, or control behavior. */
export function shouldIgnoreReaderKeyboardEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return true;
  if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(event.key)) return true;
  if (event.target instanceof Element && event.target.closest(CONTROL_SELECTOR)) return true;
  if (document.querySelector('[aria-modal="true"]')) return true;
  return window.getSelection()?.isCollapsed === false;
}
