import { useLayoutEffect, useState } from 'react';
import { createMangaStageClickController } from '../services/mangaStageClickController';
import type { MangaStageClickAction } from '../services/mangaStageClickController';

export function useMangaStageClicks(
  identity: string,
  onSingleClick: (action: MangaStageClickAction) => void,
  onDoubleClick: () => void,
) {
  const [controller] = useState(() => createMangaStageClickController({ onSingleClick, onDoubleClick }));
  useLayoutEffect(() => {
    controller.configure({ onSingleClick, onDoubleClick });
  }, [controller, onSingleClick, onDoubleClick]);
  useLayoutEffect(() => () => controller.cancel(), [controller, identity]);
  return controller;
}
