import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../../shared/api';
import { getAiModelSettings, getAiModelSettingsChanges, getAvailableAiModels, removeAiModelSettings, saveAiModelSettings, testAiProvider } from './aiModelSettingsService';

vi.mock('../../../shared/api', () => ({ apiRequest: vi.fn() }));

const backendSettings = {
  api_key_configured: true,
  audiobook_api_key_configured: true,
  audiobook_provider_base_url: 'https://speech.example.com/v1',
  audiobook_tts_model: 'voice-model',
  audiobook_tts_voice: 'alloy',
  provider_base_url: 'https://api.example.com/v1',
  translation_model: 'text-model',
  translation_secondary_model: 'deepseek-v4-flash',
  translation_prompt: '人名使用既定译法。',
  translation_concurrency: 4,
};

describe('aiModelSettingsService', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('maps account provider settings without an API key value', async () => {
    vi.mocked(apiRequest).mockResolvedValue(backendSettings);
    await expect(getAiModelSettings()).resolves.toEqual({
      apiKeyConfigured: true,
      audiobookApiKeyConfigured: true,
      audiobookProviderBaseUrl: 'https://speech.example.com/v1',
      audiobookTtsModel: 'voice-model',
      audiobookTtsVoice: 'alloy',
      providerBaseUrl: 'https://api.example.com/v1',
      translationModel: 'text-model',
      translationSecondaryModel: 'deepseek-v4-flash',
      translationPrompt: '人名使用既定译法。',
      translationConcurrency: 4,
    });
  });

  it('saves provider credentials and both model choices', async () => {
    vi.mocked(apiRequest).mockResolvedValue(backendSettings);
    await saveAiModelSettings({
      apiKey: 'secret',
      audiobookApiKey: 'speech-secret',
      audiobookProviderBaseUrl: 'https://speech.example.com/v1',
      audiobookTtsModel: 'voice-model',
      audiobookTtsVoice: 'alloy',
      providerBaseUrl: 'https://api.example.com/v1',
      translationModel: 'text-model',
      translationPrompt: ' 对话保持克制。 ',
      translationConcurrency: 3,
    });
    expect(apiRequest).toHaveBeenCalledWith('/auth/me/ai-settings', expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[0][1]!.body as string)).toEqual({
        api_key: 'secret',
        audiobook_api_key: 'speech-secret',
        audiobook_provider_base_url: 'https://speech.example.com/v1',
        audiobook_tts_model: 'voice-model',
        audiobook_tts_voice: 'alloy',
        provider_base_url: 'https://api.example.com/v1',
        translation_model: 'text-model',
        translation_prompt: '对话保持克制。',
        translation_concurrency: 3,
    });
  });

  it('updates only the edited preset without resubmitting saved credentials', async () => {
    vi.mocked(apiRequest).mockResolvedValue(backendSettings);
    const saved = await getAiModelSettings();
    const changes = getAiModelSettingsChanges({ ...saved, apiKey: '', audiobookApiKey: '', translationPrompt: '新预设' }, saved);
    expect(changes).toEqual({ translationPrompt: '新预设' });
    await saveAiModelSettings(changes);
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[1][1]!.body as string)).toEqual({ translation_prompt: '新预设' });
  });

  it('preserves explicit field clears while omitting unmodified provider fields', async () => {
    vi.mocked(apiRequest).mockResolvedValue(backendSettings);
    await saveAiModelSettings({ audiobookProviderBaseUrl: '', translationPrompt: '' });
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[0][1]!.body as string)).toEqual({ audiobook_provider_base_url: null, translation_prompt: null });
  });

  it('clears only audiobook credentials when its entire configuration is cleared', async () => {
    vi.mocked(apiRequest).mockResolvedValue(backendSettings);
    const saved = await getAiModelSettings();
    const changes = getAiModelSettingsChanges({ ...saved, apiKey: '', audiobookApiKey: '', audiobookProviderBaseUrl: '', audiobookTtsModel: '', audiobookTtsVoice: '' }, saved);
    expect(changes).toEqual({ audiobookProviderBaseUrl: '', audiobookTtsModel: '', audiobookTtsVoice: '', clearAudiobookApiKey: true });
    await saveAiModelSettings(changes);
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[1][1]!.body as string)).toEqual({ audiobook_provider_base_url: null, audiobook_tts_model: null, audiobook_tts_voice: null, clear_audiobook_api_key: true });
  });

  it('clears translation credentials without discarding presets or the audiobook provider', async () => {
    vi.mocked(apiRequest).mockResolvedValue(backendSettings);
    const saved = await getAiModelSettings();
    const changes = getAiModelSettingsChanges({ ...saved, apiKey: '', audiobookApiKey: '', providerBaseUrl: '', translationModel: '' }, saved);
    expect(changes).toEqual({ providerBaseUrl: '', translationModel: '', clearApiKey: true });
  });

  it('does not infer credential removal from an incomplete replacement or a preset-only edit', async () => {
    vi.mocked(apiRequest).mockResolvedValue(backendSettings);
    const saved = await getAiModelSettings();
    expect(getAiModelSettingsChanges({ ...saved, apiKey: '', audiobookApiKey: '', audiobookTtsModel: '' }, saved)).toEqual({ audiobookTtsModel: '' });
    expect(getAiModelSettingsChanges({ ...saved, apiKey: '', audiobookApiKey: '', translationPrompt: '新预设' }, saved)).toEqual({ translationPrompt: '新预设' });
  });

  it('tests unsaved credentials and loads their model choices', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ available: true, models: ['model-a'] });
    await testAiProvider({ apiKey: 'secret', credentialScope: 'translation', providerBaseUrl: 'https://api.example.com/v1' });
    expect(apiRequest).toHaveBeenCalledWith('/auth/me/ai-models', {
      body: JSON.stringify({ api_key: 'secret', credential_scope: 'translation', provider_base_url: 'https://api.example.com/v1' }),
      method: 'POST',
    });
  });

  it('loads and removes saved provider settings', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ available: true, models: ['model-a'] }).mockResolvedValueOnce(backendSettings);
    await expect(getAvailableAiModels()).resolves.toEqual({ available: true, models: ['model-a'] });
    await removeAiModelSettings();
    expect(apiRequest).toHaveBeenLastCalledWith('/auth/me/ai-settings', { method: 'DELETE' });
  });
});
