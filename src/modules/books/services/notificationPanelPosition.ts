export interface NotificationPanelPosition {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
}

interface PanelViewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
}

export function getNotificationPanelPosition(trigger: { right: number; bottom: number }, viewport: PanelViewport): NotificationPanelPosition {
  const horizontalMargin = Math.min(8, viewport.width / 2);
  const verticalMargin = Math.min(8, viewport.height / 2);
  const width = Math.min(360, Math.max(0, viewport.width - horizontalMargin * 2));
  const minimumLeft = viewport.offsetLeft + horizontalMargin;
  const maximumLeft = Math.max(minimumLeft, viewport.offsetLeft + viewport.width - width - horizontalMargin);
  const left = Math.min(Math.max(trigger.right - width, minimumLeft), maximumLeft);
  const minimumTop = viewport.offsetTop + verticalMargin;
  const bottom = viewport.offsetTop + viewport.height;
  const maximumTop = Math.max(minimumTop, bottom - 240 - verticalMargin);
  const top = Math.min(Math.max(trigger.bottom + 10, minimumTop), maximumTop);
  return { left, top, width, maxHeight: Math.max(0, bottom - top - verticalMargin) };
}
