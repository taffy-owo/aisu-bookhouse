export function formatAccountCode(accountNumber?: number | null, fallbackId?: string) {
  if (typeof accountNumber === 'number' && Number.isFinite(accountNumber) && accountNumber > 0) {
    return `#${accountNumber.toString().padStart(4, '0')}`;
  }

  if (fallbackId) {
    return `#${fallbackId.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  }

  return '#----';
}
