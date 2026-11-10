export type MangaStageClickAction = 'previous' | 'next' | 'controls';

interface MangaStageClickHandlers {
  onSingleClick: (action: MangaStageClickAction) => void;
  onDoubleClick: () => void;
}

// The image also supports double-click zoom. Wait for the second click before
// committing a stage navigation; buttons and keyboard navigation stay immediate.
const SINGLE_CLICK_DELAY_MS = 500;

export function createMangaStageClickController(initialHandlers: MangaStageClickHandlers) {
  let handlers = initialHandlers;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    configure: (nextHandlers: MangaStageClickHandlers) => { handlers = nextHandlers; },
    cancel,
    click: (action: MangaStageClickAction, clickCount: number) => {
      cancel();
      if (clickCount > 1) return;
      timer = setTimeout(() => {
        timer = null;
        handlers.onSingleClick(action);
      }, SINGLE_CLICK_DELAY_MS);
    },
    doubleClick: () => {
      cancel();
      handlers.onDoubleClick();
    },
  };
}
