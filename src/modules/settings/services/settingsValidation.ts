export interface SettingsValidationIssue { field: string; message: string }

export interface ChannelModelDraft {
  model: string;
  enabled: boolean;
  maxConcurrency: number;
  chunkCharacters: number | string;
  chunkParagraphs: number;
}

export function providerUrlError(value: string): string | undefined {
  const text = value.trim();
  if (!text) return '请填写 Base URL';
  try {
    const url = new URL(text);
    if (!/^https:\/\//i.test(text) || url.protocol !== 'https:' || !url.hostname || text.includes('\\')) return 'Base URL 必须是完整的 HTTPS 地址';
    if (url.username || url.password || url.search || url.hash || /[?#]/.test(text)) return 'Base URL 不能包含账号、查询参数或片段';
    if (url.port && url.port !== '443') return 'Base URL 仅允许 HTTPS 443 端口';
  } catch { return 'Base URL 必须是完整的 HTTPS 地址'; }
  return undefined;
}

function validModelName(value: string): boolean {
  const text = value.trim();
  return Boolean(text && Array.from(text).length <= 128 && !/\s/u.test(text)
    && !Array.from(text).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
}

export function channelModelField(model: string, field: 'model' | 'maxConcurrency' | 'chunkCharacters'): string {
  return `model:${model}:${field}`;
}

export function getChannelValidationIssues(draft: { name: string; baseUrl: string; apiKey: string; keyConfigured: boolean; models: ChannelModelDraft[] }): SettingsValidationIssue[] {
  const issues: SettingsValidationIssue[] = [];
  if (!draft.name.trim()) issues.push({ field: 'name', message: '请填写渠道名称' });
  const urlError = providerUrlError(draft.baseUrl);
  if (urlError) issues.push({ field: 'baseUrl', message: urlError });
  if (!draft.apiKey.trim() && !draft.keyConfigured) issues.push({ field: 'apiKey', message: '请填写 API Key' });
  for (const model of draft.models) {
    if (!model.model.trim() || Array.from(model.model.trim()).length > 128) issues.push({ field: channelModelField(model.model, 'model'), message: '模型名称需为 1–128 个字符' });
    if (!Number.isInteger(model.maxConcurrency) || model.maxConcurrency < 1 || model.maxConcurrency > 16) issues.push({ field: channelModelField(model.model, 'maxConcurrency'), message: '并发上限需为 1–16 的整数' });
    const value = Number(model.chunkCharacters);
    if (String(model.chunkCharacters).trim() === '' || !Number.isInteger(value) || value < 500 || value > 20000) issues.push({ field: channelModelField(model.model, 'chunkCharacters'), message: '分块字数需为 500–20,000 的整数' });
  }
  return issues;
}

export function getProviderValidationIssues(kind: 'translation' | 'audiobook', draft: { baseUrl: string; apiKey: string; model: string; voice: string }, keyConfigured: boolean, connectionOnly = false): SettingsValidationIssue[] {
  if (!connectionOnly && !draft.baseUrl.trim() && !draft.apiKey.trim() && !draft.model.trim() && !draft.voice.trim()) return [];
  const issues: SettingsValidationIssue[] = [];
  const urlError = providerUrlError(draft.baseUrl);
  if (urlError) issues.push({ field: `${kind}-provider-base-url`, message: urlError });
  if (!draft.apiKey.trim() && !keyConfigured) issues.push({ field: `${kind}-provider-api-key`, message: '请填写 API Key' });
  if (!connectionOnly) {
    if (!draft.model.trim()) issues.push({ field: `${kind}-model`, message: '请填写模型名称，或先获取模型列表' });
    else if (!validModelName(draft.model)) issues.push({ field: `${kind}-model`, message: '模型名称最多 128 个字符，不能包含空格或控制字符' });
    if (draft.voice.trim() && !validModelName(draft.voice)) issues.push({ field: 'audiobook-voice', message: '音色名称最多 128 个字符，不能包含空格或控制字符' });
  }
  return issues;
}

export function focusSettingsField(root: HTMLElement | null, field: string): void {
  const target = [...(root?.querySelectorAll<HTMLElement>('[data-validation-field], [name]') ?? [])].find((element) => element.dataset.validationField === field || element.getAttribute('name') === field);
  if (!target) return;
  for (let ancestor = target.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
  }
  window.requestAnimationFrame(() => { if (target.isConnected) { target.focus(); target.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } });
}
