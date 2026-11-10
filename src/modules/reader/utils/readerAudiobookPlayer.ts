export const AUDIOBOOK_LAYOUT_EVENT = 'aisu-reader-audiobook-layout';

/** Player modes replace their section without remounting the surrounding reader. */
export function observeReaderAudiobookPlayer(
  root: Element,
  sizes: ResizeObserver,
  onChange: (player: HTMLElement | null) => void,
): () => void {
  let player: HTMLElement | null = null;
  const refresh = () => {
    const next = root.querySelector<HTMLElement>('[aria-label="听书播放器"]');
    if (next === player) return;
    if (player) sizes.unobserve(player);
    player = next;
    if (player) sizes.observe(player);
    onChange(player);
  };
  const replacements = new MutationObserver(refresh);
  // The player is a direct child of the reader root. Ignore prose/status
  // updates so following does not re-query the player on every text change.
  replacements.observe(root, { childList: true });
  const handleLayout = (event: Event) => { if (event.target === player) onChange(player); };
  root.addEventListener(AUDIOBOOK_LAYOUT_EVENT, handleLayout);
  refresh();
  return () => {
    replacements.disconnect();
    root.removeEventListener(AUDIOBOOK_LAYOUT_EVENT, handleLayout);
    if (player) sizes.unobserve(player);
  };
}
