import { useLayoutEffect, useRef, type SyntheticEvent } from 'react';
import { useFocusOwnership } from '../../../shared/hooks/useFocusOwnership';

const CONTROLS = 'button, a[href], select, input, textarea, summary';
const ROWS = '[data-task-focus-id]';
const controlKey = (element: HTMLElement) => element.dataset.taskFocusControl
  ?? `${element.tagName}:${element.getAttribute('aria-label') || element.title || element.textContent?.trim() || ''}`;

/** Keep task controls reachable when asynchronous updates move or replace them. */
export function useTaskFocus(accountScope: string) {
  const taskPanelRef = useRef<HTMLDivElement>(null);
  const intentRef = useRef<{ accountScope: string; rowId?: string; index: number; control: string } | null>(null);
  const fallbackRef = useRef<HTMLElement | null>(null);
  const ownsFocus = useFocusOwnership();

  const rememberTaskFocus = (event: SyntheticEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>(CONTROLS);
    if (!control || !event.currentTarget.contains(control)) return;
    const row = control.closest<HTMLElement>(ROWS);
    intentRef.current = {
      accountScope,
      rowId: row?.dataset.taskFocusId,
      index: row ? [...event.currentTarget.querySelectorAll<HTMLElement>(ROWS)].filter(element => element.getClientRects().length > 0).indexOf(row) : -1,
      control: controlKey(control),
    };
    fallbackRef.current = null;
  };

  useLayoutEffect(() => {
    const root = taskPanelRef.current, intent = intentRef.current;
    if (!intent || intent.accountScope !== accountScope) {
      intentRef.current = null;
      fallbackRef.current = null;
      return;
    }
    if (!root || !ownsFocus(root)) return;
    const rows = [...root.querySelectorAll<HTMLElement>(ROWS)].filter(element => element.getClientRects().length > 0);
    const row = rows.find(element => element.dataset.taskFocusId === intent.rowId)
      ?? (intent.rowId ? rows[Math.min(intent.index, rows.length - 1)] : undefined);
    const owner = intent.rowId ? row ?? root : root;
    const busy = root.getAttribute('aria-busy') === 'true' || row?.getAttribute('aria-busy') === 'true';
    const active = document.activeElement;
    const activeControlDisabled = active instanceof HTMLElement && active.matches(':disabled');
    const activeTaskRow = Boolean(row && active instanceof Node && row.contains(active));
    if (active !== document.body && active !== fallbackRef.current
        && !(busy && activeTaskRow && activeControlDisabled)) return;
    const controls = [...owner.querySelectorAll<HTMLElement>(CONTROLS)]
      .filter(element => !element.matches(':disabled') && element.getClientRects().length > 0);
    const target = busy ? owner
      : controls.find(element => (!intent.rowId || row?.dataset.taskFocusId === intent.rowId) && controlKey(element) === intent.control)
        ?? controls.find(element => element.hasAttribute('data-task-focus-primary'))
        ?? controls[0]
        ?? owner;
    if (target === document.activeElement) return;
    fallbackRef.current = target.matches(CONTROLS) ? null : target;
    target.focus({ preventScroll: true });
    if (target !== root) target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });

  return { taskPanelRef, rememberTaskFocus };
}
