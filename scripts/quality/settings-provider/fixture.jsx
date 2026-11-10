import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AppLayout } from '../../../src/app/AppLayout';
import { SessionProvider } from '../../../src/app/SessionProvider';
import { useSession } from '../../../src/app/SessionContext';
import { getAccountScope, setAccessToken, setStoredSession } from '../../../src/shared/api';
import { ThemeProvider } from '../../../src/shared/theme';
import { SettingsPage } from '../../../src/modules/settings/pages/SettingsPage';
import { notifyAiConfigurationChanged } from '../../../src/modules/settings/services/aiConfigurationEvents';
import '../../../src/index.css';

// Real settings/session components; requests never leave this local fixture.
const query = new URLSearchParams(location.search);
localStorage.setItem('aisu-theme', query.has('dark') ? 'dark' : 'light');
const user = id => ({ id, account_number: id === 'settings-a' ? 1 : 2, nickname: id, email: id + '@example.local', role: 'user', status: 'active' });
let currentUser = user('settings-a');
setStoredSession(currentUser); setAccessToken('local-fixture-only');
const defaults = () => ({ api_key_configured: true, audiobook_api_key_configured: true,
  provider_base_url: 'https://translation.example.local/v1', translation_model: 'model-20',
  audiobook_provider_base_url: 'https://audio.example.local/v1', audiobook_tts_model: 'model-20', audiobook_tts_voice: 'alloy',
  translation_secondary_model: '', translation_prompt: '原有预设', translation_concurrency: 2 });
const channelModel = (model, enabled = true) => ({ id: model, model, display_name: model, enabled,
  sort_order: 0, max_concurrency: 4, chunk_characters: 4500, chunk_paragraphs: 220,
  available: true, unavailable_until: null, unavailable_reason: '' });
const channels = account => [0, 1].map(index => ({ id: account + '-' + index,
  name: index ? '备用渠道' : '主翻译渠道', base_url: 'https://channel.example.local/v1', api_key_configured: true,
  credential_scope: 'personal', enabled: true, sort_order: index, updated_at: '2026-10-30T00:00:00Z',
  models: index ? [channelModel('model-c')] : [channelModel('model-a'), channelModel('model-b', false)] }));
const fixture = {
  settings: { 'settings-a': defaults(), 'settings-b': { ...defaults(), translation_model: 'other-account-model' } },
  requests: [], reads: [], pending: [], pendingReads: [], hold: false, holdReads: false,
  fail: false, failReads: false, ignoreAbort: false, error: '服务暂时不可用，请稍后重试。',
  models: Array.from({ length: 40 }, (_, i) => 'model-' + String(i + 1).padStart(2, '0')),
  channelConfigs: { 'settings-a': query.has('channels') ? channels('settings-a') : [], 'settings-b': query.has('channels') ? channels('settings-b') : [] },
  channelRequests: [], channelReads: [], channelPending: [], channelPendingReads: [], channelHold: false, channelHoldReads: false,
  channelFail: false, channelFailReads: false, channelIgnoreAbort: false, channelProbeOk: true, channelProbeDetail: '已获取最新模型列表',
  channelModels: ['model-a', 'model-b', 'model-new'], channelVersion: 0, confirmations: [], confirmResult: true,
  release() { this.hold = false; this.pending.splice(0).forEach(resolve => resolve()); },
  releaseReads() { this.holdReads = false; this.pendingReads.splice(0).forEach(resolve => resolve()); },
  refresh() { notifyAiConfigurationChanged('channel', getAccountScope()); },
  refreshChannels() { notifyAiConfigurationChanged('provider', getAccountScope()); },
  releaseChannels() { this.channelHold = false; this.channelPending.splice(0).forEach(resolve => resolve()); },
  releaseChannelReads() { this.channelHoldReads = false; this.channelPendingReads.splice(0).forEach(resolve => resolve()); },
  updateChannel(patch, index = 0) { Object.assign(this.channelConfigs[currentUser.id][index], patch, { updated_at: 'revision-' + ++this.channelVersion }); },
  switchAccount() {
    currentUser = user(currentUser.id === 'settings-a' ? 'settings-b' : 'settings-a');
    setStoredSession(currentUser); setAccessToken('local-fixture-' + currentUser.id);
    window.dispatchEvent(new StorageEvent('storage', { key: 'aisu-bookhouse:session' }));
  },
};
window.settingsFixture = fixture;
window.confirm = message => { fixture.confirmations.push(message); return fixture.confirmResult; };
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) throw Error('Unexpected fixture request ' + url.pathname);
  const p = url.pathname.replace(/^\/api\/v1/, ''), method = options.method || 'GET';
  if (p === '/auth/me') return Response.json(currentUser);
  if (p === '/auth/me/ai-settings' && method === 'GET') {
    const snapshot = structuredClone(fixture.settings[currentUser.id]), fail = fixture.failReads, error = fixture.error;
    const request = { account: currentUser.id, aborted: false }; fixture.reads.push(request);
    options.signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
    if (fixture.holdReads) await new Promise((resolve, reject) => {
      fixture.pendingReads.push(resolve);
      if (!fixture.ignoreAbort) options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return fail ? Response.json({ detail: error }, { status: 422 }) : Response.json(snapshot);
  }
  if (p === '/auth/me/ai-models' || p === '/auth/me/ai-settings') {
    const body = JSON.parse(options.body || '{}'), account = currentUser.id;
    const request = { operation: p.endsWith('ai-models') ? 'probe' : method === 'DELETE' ? 'remove' : 'save', method, kind: body.credential_scope, fields: Object.keys(body), account, aborted: false };
    const fail = fixture.fail, error = fixture.error, models = [...fixture.models], ignoreAbort = fixture.ignoreAbort;
    fixture.requests.push(request);
    options.signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
    if (fixture.hold) await new Promise((resolve, reject) => {
      fixture.pending.push(resolve);
      if (!ignoreAbort) options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    if (fail) return Response.json({ detail: error }, { status: 422 });
    if (request.operation === 'probe') return Response.json({ available: true, models });
    const saved = fixture.settings[account];
    if (request.operation === 'remove') {
      Object.assign(saved, { api_key_configured: false, audiobook_api_key_configured: false,
        provider_base_url: '', translation_model: '', translation_secondary_model: '', translation_prompt: '', translation_concurrency: 2,
        audiobook_provider_base_url: '', audiobook_tts_model: '', audiobook_tts_voice: '' });
      fixture.channelConfigs[account] = fixture.channelConfigs[account].filter(channel => !channel.is_provider_default);
      return Response.json(saved);
    }
    for (const [key, value] of Object.entries(body)) {
      if (key === 'api_key') saved.api_key_configured = !!value;
      else if (key === 'audiobook_api_key') saved.audiobook_api_key_configured = !!value;
      else if (!key.startsWith('clear_')) saved[key] = value ?? '';
    }
    return Response.json(saved);
  }
  if (p === '/ai-channels' && method === 'GET') {
    const snapshot = structuredClone(fixture.channelConfigs[currentUser.id]), fail = fixture.channelFailReads, error = fixture.error;
    const request = { account: currentUser.id, aborted: false }; fixture.channelReads.push(request);
    options.signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
    if (fixture.channelHoldReads) await new Promise((resolve, reject) => {
      fixture.channelPendingReads.push(resolve);
      if (!fixture.channelIgnoreAbort) options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return fail ? Response.json({ detail: error }, { status: 422 }) : Response.json(snapshot);
  }
  if (p.startsWith('/ai-channels')) {
    const account = currentUser.id, configs = fixture.channelConfigs[account];
    const id = p.split('/')[2], body = JSON.parse(options.body || '{}');
    const operation = p.endsWith('/probe') ? 'probe' : method === 'DELETE' ? 'delete' : method === 'POST' ? 'create' : 'save';
    const request = { operation, account, id, body: { ...body, api_key: body.api_key ? '[fixture key]' : undefined }, aborted: false };
    const fail = fixture.channelFail, error = fixture.error, models = [...fixture.channelModels], ok = fixture.channelProbeOk, detail = fixture.channelProbeDetail;
    fixture.channelRequests.push(request);
    options.signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
    if (fixture.channelHold) await new Promise((resolve, reject) => {
      fixture.channelPending.push(resolve);
      if (!fixture.channelIgnoreAbort) options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    if (fail) return Response.json({ detail: error }, { status: 422 });
    if (operation === 'probe') return Response.json({ channel_id: id, ok, detail, models });
    const index = configs.findIndex(channel => channel.id === id);
    if (operation === 'delete') { configs.splice(index, 1); return Response.json({ deleted: 1 }); }
    if (operation === 'save' && (index < 0 || body.expected_updated_at !== configs[index].updated_at)) return Response.json({ detail: '渠道已被其他操作更新，请重新读取。' }, { status: 409 });
    const saved = operation === 'create' ? { ...channels(account)[0], id: account + '-created-' + ++fixture.channelVersion, models: [] } : configs[index];
    for (const field of ['name', 'base_url', 'enabled']) if (body[field] !== undefined) saved[field] = body[field];
    if (body.models) saved.models = body.models.map(model => ({ ...channelModel(model.model), ...model }));
    saved.updated_at = 'revision-' + ++fixture.channelVersion;
    if (operation === 'create') configs.push(saved);
    return Response.json(saved);
  }
  if (p.includes('notifications')) return Response.json({ items: [], unread_count: 0, active_count: 0 });
  throw Error('Unexpected API ' + method + ' ' + p);
};
function Harness() {
  const navigate = useNavigate(), { isLoading, session } = useSession();
  fixture.navigate = navigate;
  if (isLoading || !session) return <p>读取测试账号…</p>;
  return <Routes><Route element={<AppLayout />}><Route path="/settings" element={<SettingsPage />} /><Route path="/away" element={<button id="reopen" onClick={() => navigate('/settings')}>回到设置</button>} /></Route></Routes>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><ThemeProvider><SessionProvider><MemoryRouter initialEntries={['/settings']}><Harness /></MemoryRouter></SessionProvider></ThemeProvider></React.StrictMode>);
