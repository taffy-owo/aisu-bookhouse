interface BookSelectionControlProps {
  bookId: string;
  title: string;
  isSelected: boolean;
  onSelect?: (bookId: string) => void;
}

/** One focus stop for the entire book while bulk management is active. */
export function BookSelectionControl({ bookId, title, isSelected, onSelect }: BookSelectionControlProps) {
  return <>
    <input
      aria-label={`选择《${title}》`}
      checked={isSelected}
      className="peer absolute inset-0 z-40 m-0 h-full w-full cursor-pointer opacity-0"
      onChange={() => onSelect?.(bookId)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (!event.repeat) event.currentTarget.click();
      }}
      type="checkbox"
    />
    <span aria-hidden className="pointer-events-none absolute inset-0 z-40 rounded-lg peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-peach" />
  </>;
}
