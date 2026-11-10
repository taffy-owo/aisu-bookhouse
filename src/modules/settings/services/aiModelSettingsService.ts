import { apiRequest } from '../../../shared/api';
import { getAccountScope } from '../../../shared/api/authTokenStore';
import { notifyAiConfigurationChanged } from './aiConfigurationEvents';

export type AiModelSettings = {
  apiKeyConfigured: boolean;
  audiobookApiKeyConfigured: boolean;
  audiobookProviderBaseUrl: string;
  audiobookTtsModel: string;
  audiobookTtsVoice: string;
  providerBaseUrl: string;
  translationModel: string;
  translationSecondaryModel: string;
  translationPrompt: string;
  translationConcurrency: number;
};

type BackendAiModelSettings = {
  api_key_configured: boolean;
  audiobook_api_key_configured: boolean;
  audiobook_provider_base_url: string;
  audiobook_tts_model: string;
  audiobook_tts_voice: string;
  provider_base_url: string;
  translation_model: string;
  translation_secondary_model: string;
  translation_prompt: string;
  translation_concurrency: number;
};

export async function getAiModelSettings(signal?: AbortSignal): Promise<AiModelSettings> {
  return mapAiModelSettings(await apiRequest<BackendAiModelSettings>('/auth/me/ai-settings', { signal }));
}

export async function getAvailableAiModels(): Promise<{ available: boolean; models: string[] }> {
  return apiRequest<{ available: boolean; models: string[] }>('/auth/me/ai-models');
}

export async function testAiProvider(input: {
  apiKey: string;
  credentialScope: 'translation' | 'audiobook';
  providerBaseUrl: string;
  signal?: AbortSignal;
}): Promise<{ available: boolean; models: string[] }> {
  return apiRequest<{ available: boolean; models: string[] }>('/auth/me/ai-models', {
    body: JSON.stringify({
      api_key: input.apiKey.trim() || null,
      credential_scope: input.credentialScope,
      provider_base_url: input.providerBaseUrl.trim(),
    }),
    method: 'POST',
    signal: input.signal,
  });
}

export interface SaveAiModelSettingsInput {
  apiKey?: string;
  audiobookApiKey?: string;
  audiobookProviderBaseUrl?: string;
  audiobookTtsModel?: string;
  audiobookTtsVoice?: string;
  providerBaseUrl?: string;
  translationModel?: string;
  translationPrompt?: string;
  translationConcurrency?: number;
  clearApiKey?: boolean;
  clearAudiobookApiKey?: boolean;
  signal?: AbortSignal;
}

export function getAiModelSettingsChanges(draft: Required<Omit<SaveAiModelSettingsInput, 'signal' | 'clearApiKey' | 'clearAudiobookApiKey'>>, saved: AiModelSettings): SaveAiModelSettingsInput {
  const changes: SaveAiModelSettingsInput = {};
  for (const key of ['providerBaseUrl', 'translationModel', 'translationPrompt', 'audiobookProviderBaseUrl', 'audiobookTtsModel', 'audiobookTtsVoice'] as const) {
    if (draft[key].trim() !== saved[key]) changes[key] = draft[key];
  }
  if (draft.translationConcurrency !== saved.translationConcurrency) changes.translationConcurrency = draft.translationConcurrency;
  if (draft.apiKey.trim()) changes.apiKey = draft.apiKey;
  if (draft.audiobookApiKey.trim()) changes.audiobookApiKey = draft.audiobookApiKey;
  if (saved.apiKeyConfigured && (saved.providerBaseUrl || saved.translationModel) && !draft.providerBaseUrl.trim() && !draft.translationModel.trim() && !draft.apiKey.trim()) changes.clearApiKey = true;
  if (saved.audiobookApiKeyConfigured && (saved.audiobookProviderBaseUrl || saved.audiobookTtsModel || saved.audiobookTtsVoice) && !draft.audiobookProviderBaseUrl.trim() && !draft.audiobookTtsModel.trim() && !draft.audiobookTtsVoice.trim() && !draft.audiobookApiKey.trim()) changes.clearAudiobookApiKey = true;
  return changes;
}

export async function saveAiModelSettings(input: SaveAiModelSettingsInput): Promise<AiModelSettings> {
  const accountScope = getAccountScope();
  const body: Record<string, unknown> = {};
  for (const [key, field] of [
    ['apiKey', 'api_key'], ['audiobookApiKey', 'audiobook_api_key'], ['audiobookProviderBaseUrl', 'audiobook_provider_base_url'],
    ['audiobookTtsModel', 'audiobook_tts_model'], ['audiobookTtsVoice', 'audiobook_tts_voice'], ['translationPrompt', 'translation_prompt'],
  ] as const) if (input[key] !== undefined) body[field] = input[key].trim() || null;
  if (input.providerBaseUrl !== undefined) body.provider_base_url = input.providerBaseUrl.trim();
  if (input.translationModel !== undefined) body.translation_model = input.translationModel.trim();
  if (input.translationConcurrency !== undefined) body.translation_concurrency = input.translationConcurrency;
  if (input.clearApiKey !== undefined) body.clear_api_key = input.clearApiKey;
  if (input.clearAudiobookApiKey !== undefined) body.clear_audiobook_api_key = input.clearAudiobookApiKey;
  const saved = mapAiModelSettings(await apiRequest<BackendAiModelSettings>('/auth/me/ai-settings', {
    body: JSON.stringify(body),
    method: 'PUT',
    ...(input.signal ? { signal: input.signal } : {}),
  }));
  notifyAiConfigurationChanged('provider', accountScope);
  return saved;
}

export async function removeAiModelSettings(signal?: AbortSignal): Promise<AiModelSettings> {
  const accountScope = getAccountScope();
  const cleared = mapAiModelSettings(await apiRequest<BackendAiModelSettings>('/auth/me/ai-settings', { method: 'DELETE', ...(signal ? { signal } : {}) }));
  notifyAiConfigurationChanged('provider', accountScope);
  return cleared;
}

function mapAiModelSettings(settings: BackendAiModelSettings): AiModelSettings {
  return {
    apiKeyConfigured: settings.api_key_configured,
    audiobookApiKeyConfigured: settings.audiobook_api_key_configured,
    audiobookProviderBaseUrl: settings.audiobook_provider_base_url,
    audiobookTtsModel: settings.audiobook_tts_model,
    audiobookTtsVoice: settings.audiobook_tts_voice,
    providerBaseUrl: settings.provider_base_url,
    translationModel: settings.translation_model,
    translationSecondaryModel: settings.translation_secondary_model,
    translationPrompt: settings.translation_prompt,
    translationConcurrency: settings.translation_concurrency,
  };
}
