type ReaderViewport = Pick<VisualViewport, 'width' | 'height' | 'offsetLeft' | 'offsetTop' | 'scale'>;

/** A layout-viewport sidebar is only visible in full when the visual viewport matches it. */
export function canDockReaderToc(viewport: ReaderViewport | null | undefined, layoutWidth: number, layoutHeight: number): boolean {
  return !viewport || (viewport.scale === 1 && Math.abs(viewport.offsetLeft) <= 1 && Math.abs(viewport.offsetTop) <= 1
    && viewport.width >= layoutWidth - 1 && viewport.height >= layoutHeight - 1);
}
