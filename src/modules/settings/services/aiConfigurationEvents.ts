import { getAccountScope } from '../../../shared/api/authTokenStore';

type ConfigurationSource = 'provider' | 'channel';
const CHANGED_EVENT = 'aisu:ai-configuration-changed';

export function notifyAiConfigurationChanged(source: ConfigurationSource, accountScope: string): void {
  if (typeof window === 'undefined' || accountScope !== getAccountScope()) return;
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { source, accountScope } }));
}

export function subscribeAiConfigurationChanges(source: ConfigurationSource, onChange: () => void): () => void {
  const accountScope = getAccountScope();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ source?: string; accountScope?: string }>).detail;
    if (detail?.source === source && detail.accountScope === accountScope && accountScope === getAccountScope()) onChange();
  };
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}
