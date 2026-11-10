import { useDialogFocus } from '../../../shared/hooks/useDialogFocus';

interface ReaderPanelDismissOptions {
  isOpen?: boolean;
  onClose: () => void;
}

/** Reader sheets share focus trapping, Escape, scroll lock, and focus restore. */
export function useReaderPanelDismiss({ onClose, isOpen = true }: ReaderPanelDismissOptions) {
  return useDialogFocus<HTMLElement>(isOpen, onClose);
}
