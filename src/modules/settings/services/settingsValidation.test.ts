import { describe, expect, it } from 'vitest';
import { getChannelValidationIssues, getProviderValidationIssues, providerUrlError } from './settingsValidation';

const model = { model: 'model-a', enabled: true, maxConcurrency: 4, chunkCharacters: 4500 as number | string, chunkParagraphs: 220 };
const channel = { name: '渠道', baseUrl: 'https://api.example.com/v1', apiKey: '', keyConfigured: true, models: [model] };

describe('settings validation', () => {
  it.each(['', '499', '20001', '4500.5', 'not-a-number', 'Infinity'])('rejects invalid chunk character draft %s', (chunkCharacters) => {
    expect(getChannelValidationIssues({ ...channel, models: [{ ...model, chunkCharacters }] })).toEqual([{ field: 'model:model-a:chunkCharacters', message: '分块字数需为 500–20,000 的整数' }]);
  });
  it.each(['500', '20000', '4500', '5e2'])('accepts valid integral character limit %s', (chunkCharacters) => {
    expect(getChannelValidationIssues({ ...channel, models: [{ ...model, chunkCharacters }] })).toEqual([]);
  });
  it.each([1, 5, 7, 16])('accepts all supported concurrency values including %d', (maxConcurrency) => {
    expect(getChannelValidationIssues({ ...channel, models: [{ ...model, maxConcurrency }] })).toEqual([]);
  });
  it('allows a blank replacement key when a saved key is available', () => {
    expect(getChannelValidationIssues(channel)).toEqual([]);
    expect(getChannelValidationIssues({ ...channel, keyConfigured: false })).toContainEqual({ field: 'apiKey', message: '请填写 API Key' });
  });
  it('keeps provider channel model identifiers with spaces compatible with the channel API', () => {
    expect(getChannelValidationIssues({ ...channel, models: [{ ...model, model: 'Provider Model 5' }] })).toEqual([]);
  });
  it.each(['http://example.com', 'not-a-url', 'https://example.com:8443', 'https://user:secret@example.com', 'https://example.com?key=value', 'https://example.com#fragment'])('rejects unsupported provider URL %s', (url) => {
    expect(providerUrlError(url)).toBeDefined();
  });
  it('keeps valid HTTPS paths and IPv6 endpoints available to server validation', () => {
    expect(providerUrlError('https://api.example.com:443/proxy/v1/')).toBeUndefined();
    expect(providerUrlError('https://[2606:4700::1111]/v1')).toBeUndefined();
  });
  it('allows clearing a provider while requiring all fields for a partial configuration', () => {
    expect(getProviderValidationIssues('audiobook', { baseUrl: '', apiKey: '', model: '', voice: '' }, true)).toEqual([]);
    expect(getProviderValidationIssues('audiobook', { baseUrl: 'https://api.example.com', apiKey: '', model: '', voice: '' }, false).map((issue) => issue.field)).toEqual(['audiobook-provider-api-key', 'audiobook-model']);
  });
  it('does not require a selected model just to fetch the model list', () => {
    expect(getProviderValidationIssues('translation', { baseUrl: 'https://api.example.com', apiKey: '', model: '', voice: '' }, true, true)).toEqual([]);
  });
});
