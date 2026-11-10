import { apiRequest } from '../../../shared/api';
import { getAccountScope } from '../../../shared/api/authTokenStore';
import { notifyAiConfigurationChanged } from './aiConfigurationEvents';

export type AiChannelModel = {
  id: string;
  model: string;
  display_name: string;
  enabled: boolean;
  sort_order: number;
  max_concurrency: number;
  chunk_characters: number;
  chunk_paragraphs: number;
  available: boolean;
  unavailable_until: string | null;
  unavailable_reason: string;
};

export type AiChannel = {
  id: string;
  name: string;
  base_url: string;
  api_key_configured: boolean;
  credential_scope: 'platform' | 'personal';
  is_provider_default?: boolean;
  enabled: boolean;
  sort_order: number;
  updated_at: string;
  models: AiChannelModel[];
};

export type AiChannelModelInput = {
  model: string;
  display_name?: string | null;
  enabled?: boolean;
  max_concurrency?: number;
  chunk_characters?: number;
  chunk_paragraphs?: number;
};

export type TranslationModelOption = {
  channel_id: string;
  channel_name: string;
  model: string;
  display_name: string;
  label: string;
  max_concurrency: number;
  available: boolean;
  unavailable_until: string | null;
  unavailable_reason: string;
  active_job_count: number;
};

export type AiChannelProbeResult = {
  channel_id: string;
  ok: boolean;
  detail: string;
  models: string[];
};

export async function getAiChannels(signal?: AbortSignal): Promise<AiChannel[]> {
  return apiRequest<AiChannel[]>('/ai-channels', { signal });
}

export async function getTranslationModelOptions(signal?: AbortSignal): Promise<TranslationModelOption[]> {
  return apiRequest<TranslationModelOption[]>('/ai-channels/translation-models', { signal });
}

export async function createAiChannel(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  models?: AiChannelModelInput[];
  signal?: AbortSignal;
}): Promise<AiChannel> {
  const accountScope = getAccountScope();
  const saved = await apiRequest<AiChannel>('/ai-channels', {
    body: JSON.stringify({
      name: input.name,
      base_url: input.baseUrl,
      api_key: input.apiKey,
      enabled: input.enabled ?? true,
      models: input.models ?? [],
    }),
    method: 'POST',
    ...(input.signal ? { signal: input.signal } : {}),
  });
  notifyAiConfigurationChanged('channel', accountScope);
  return saved;
}

export async function updateAiChannel(channelId: string, input: {
  expectedUpdatedAt?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  models?: AiChannelModelInput[];
  signal?: AbortSignal;
}): Promise<AiChannel> {
  const accountScope = getAccountScope();
  const body: Record<string, unknown> = {};
  if (input.expectedUpdatedAt !== undefined) body.expected_updated_at = input.expectedUpdatedAt;
  if (input.name !== undefined) body.name = input.name;
  if (input.baseUrl !== undefined) body.base_url = input.baseUrl;
  if (input.apiKey !== undefined) body.api_key = input.apiKey;
  if (input.enabled !== undefined) body.enabled = input.enabled;
  if (input.models !== undefined) body.models = input.models;
  const saved = await apiRequest<AiChannel>(`/ai-channels/${encodeURIComponent(channelId)}`, {
    body: JSON.stringify(body),
    method: 'PATCH',
    ...(input.signal ? { signal: input.signal } : {}),
  });
  notifyAiConfigurationChanged('channel', accountScope);
  return saved;
}

export async function deleteAiChannel(channelId: string, signal?: AbortSignal): Promise<void> {
  const accountScope = getAccountScope();
  await apiRequest<{ deleted: number }>(`/ai-channels/${encodeURIComponent(channelId)}`, { method: 'DELETE', ...(signal ? { signal } : {}) });
  notifyAiConfigurationChanged('channel', accountScope);
}

export async function probeAiChannel(channelId: string, signal?: AbortSignal): Promise<AiChannelProbeResult> {
  return apiRequest<AiChannelProbeResult>(`/ai-channels/${encodeURIComponent(channelId)}/probe`, { method: 'POST', signal });
}
