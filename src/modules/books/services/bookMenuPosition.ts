interface MenuViewport {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Position inside the visible area left by the sticky header and mobile nav. */
export function getBookMenuPosition(trigger: { top: number; bottom: number; right: number }, viewport: MenuViewport, menuHeight: number, { width: desiredWidth = 144, maxHeight: desiredMaxHeight = Infinity } = {}) {
  const gap = 8;
  const width = Math.min(desiredWidth, Math.max(0, viewport.right - viewport.left - gap * 2));
  const topEdge = viewport.top + gap;
  const bottomEdge = Math.max(topEdge, viewport.bottom - gap);
  const above = Math.max(0, trigger.top - gap - topEdge);
  const below = Math.max(0, bottomEdge - trigger.bottom - gap);
  const desiredHeight = Math.min(menuHeight, desiredMaxHeight);
  const opensAbove = below < desiredHeight && above > below;
  const maxHeight = Math.min(desiredMaxHeight, opensAbove ? above : below);
  const height = Math.min(menuHeight, maxHeight);
  return {
    left: Math.max(viewport.left + gap, Math.min(trigger.right - width, viewport.right - gap - width)),
    top: Math.max(topEdge, opensAbove ? trigger.top - gap - height : trigger.bottom + gap),
    width,
    maxHeight,
  };
}

export function focusBookMenuItem(button: HTMLButtonElement | undefined) {
  if (!button) return;
  button.focus({ preventScroll: true });
  const menu = button.closest<HTMLElement>('[role="menu"]');
  if (!menu) return;
  const itemRect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  // In a short viewport reveal the focused action inside the menu only.
  if (itemRect.bottom > menuRect.bottom - 1) menu.scrollTop += itemRect.bottom - menuRect.bottom + 1;
  else if (itemRect.top < menuRect.top + 1) menu.scrollTop += itemRect.top - menuRect.top - 1;
}
