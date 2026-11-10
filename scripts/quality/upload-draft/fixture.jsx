import React from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { SessionContext } from '../../../src/app/SessionContext';
import { AppLayout } from '../../../src/app/AppLayout';
import { ThemeProvider } from '../../../src/shared/theme/ThemeProvider';
import { UploadPage } from '../../../src/modules/uploads/pages/UploadPage';
import { getAccountScope, setStoredSession } from '../../../src/shared/api';
import '../../../src/index.css';

const query = new URLSearchParams(location.search);
const session = { id: 'draft-user-a', nickname: '草稿测试', role: 'user' };
setStoredSession(session);
localStorage.setItem('aisu-theme', query.has('dark') ? 'dark' : 'light');
const prefix = 'aisu-bookhouse:manual-book-draft';
const draft = { title: '灯下的来信', content: '上次保留的文章正文。', author: '', description: '', tags: '', sourceUrl: '', publicationStatus: 'completed' };
const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
if (query.has('seed') && !sessionStorage.getItem('upload-draft-fixture-seeded')) {
  if (!get.call(localStorage, prefix + ':' + session.id)) set.call(localStorage, prefix + ':' + session.id, JSON.stringify(draft));
  sessionStorage.setItem('upload-draft-fixture-seeded', 'true');
}
const fixture = {
  failGet: query.has('failGet'), failSet: query.has('failSet'), failRemove: query.has('failRemove'),
  sets: [], removes: [], reads: [], uploads: [], tasks: new Map(), holdUpload: false, uploadStatus: 200, pendingUploads: [],
  taskReads: [], pendingTaskReads: [], holdTaskReads: query.has('holdTaskReads'), holdTasksAfterAccept: query.has('holdTasksAfterAccept'), failTasksAfterAccept: query.has('failTasksAfterAccept'), taskStatus: 0,
  reprocesses: [],
  acceptedStatus: 'ready', fileStatuses: {},
  translationJobs: [], translationActions: [], translationActionStatus: 503, translationSubmissions: [], translationSubmitStatus: 503,
  holdTranslationActions: false, pendingTranslationActions: [], clearRequests: [],
  saved: (owner = 'draft-user-a') => JSON.parse(get.call(localStorage, prefix + ':' + owner) || 'null'),
  seed: (owner, value = draft) => set.call(localStorage, prefix + ':' + owner, JSON.stringify(value)),
};
window.draftFixture = fixture;
if (query.has('taskMessages') || query.has('taskFocus')) {
  if (query.has('taskFocus')) window.confirm = () => true;
  fixture.diagnostic = 'AI 服务暂时无法连接：' + 'upstream_response_identifier_'.repeat(16) + '\n已完成的章节仍保留，请稍后重试。';
  const job = (id, status, error = null) => ({ id, status, title: id === 'failed-long' ? '翻译失败的长书名' + '来信'.repeat(28) : id,
    source_url: 'https://kakuyomu.jp/works/1234567890', source_provider: 'kakuyomu', author: '测试作者', book_id: 'translated-' + id, job_kind: 'whole_book',
    channel_id: null, channel_name: '测试渠道', model: 'test-model', max_concurrency: 4, request_concurrency: 2,
    completed_chapters: 4, total_chapters: 12, progress: 33, stage: 'translating', message: status === 'paused' ? '翻译已暂停，可随时继续' : '正在翻译第 5 话',
    error_message: error, quality_status: 'pending', quality_issue_count: 0, pause_requested: false, acknowledged: false, quota_resume_at: null,
    created_at: '2026-10-29T08:00:00Z', updated_at: '2026-10-29T08:00:00Z', finished_at: null, current_chapter_index: 4 });
  fixture.translationJobs = [job('failed-long', 'failed', fixture.diagnostic), job('failed-short', 'failed', '网络暂时不可用，请稍后重试。'), job('paused', 'paused'), job('waiting', 'waiting_quota', fixture.diagnostic), job('processing', 'processing'), job('review', 'review'), job('ready', 'ready')];
  const record = { id: 'unconfirmed-fixture', createdAt: Date.now(), status: 'unconfirmed', error: fixture.diagnostic,
    sourceUrl: 'https://kakuyomu.jp/works/1234567890', customInstructions: '保留人物称呼与段落。', model: 'original-model', modelLabel: '原始渠道', channelId: null, requestConcurrency: 3 };
  set.call(localStorage, 'aisu-bookhouse:translation-submission:v1:' + encodeURIComponent(JSON.stringify(session.id)) + ':' + record.id, JSON.stringify(record));
}
Storage.prototype.getItem = function (key) {
  if (key.startsWith(prefix)) { fixture.reads.push(key); if (fixture.failGet) throw new DOMException('模拟禁止读取', 'SecurityError'); }
  return get.call(this, key);
};
Storage.prototype.setItem = function (key, value) {
  if (key.startsWith(prefix)) { fixture.sets.push({ key, value, failed: fixture.failSet }); if (fixture.failSet) throw new DOMException('模拟存储已满', 'QuotaExceededError'); }
  return set.call(this, key, value);
};
Storage.prototype.removeItem = function (key) {
  if (key.startsWith(prefix)) { fixture.removes.push({ key, failed: fixture.failRemove }); if (fixture.failRemove) throw new DOMException('模拟禁止清理', 'SecurityError'); }
  return remove.call(this, key);
};
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, options) => {
  const path = new URL(String(input), location.origin).pathname;
  if (!path.startsWith('/api/v1/')) return nativeFetch(input, options);
  if (path.endsWith('/uploads/tasks/completed')) {
    fixture.clearRequests.push('uploads');
    const scope = getAccountScope();
    fixture.tasks.set(scope, (fixture.tasks.get(scope) || []).filter(task => !['ready', 'failed'].includes(task.status)));
    return Response.json({ deleted: 1 });
  }
  if (path.endsWith('/translations/completed')) {
    fixture.clearRequests.push('translations');
    fixture.translationJobs = fixture.translationJobs.filter(job => !['ready', 'failed'].includes(job.status));
    return Response.json({ deleted: 1 });
  }
  if (path.endsWith('/uploads/tasks')) {
    const record = { scope: getAccountScope(), snapshot: structuredClone(fixture.tasks.get(getAccountScope()) || []), signal: options?.signal };
    fixture.taskReads.push(record);
    if (fixture.holdTaskReads || (fixture.holdTasksAfterAccept && fixture.uploads.length)) await new Promise(resolve => fixture.pendingTaskReads.push({ ...record, resolve }));
    const status = fixture.taskStatus || (fixture.failTasksAfterAccept && fixture.uploads.length ? 503 : 0);
    return status ? Response.json({ detail: '模拟上传任务读取失败' }, { status }) : Response.json(record.snapshot);
  }
  if (path.endsWith('/reprocess')) {
    const scope = getAccountScope(), bookId = path.split('/').at(-2);
    fixture.reprocesses.push({ scope, bookId, headers: options?.headers });
    const task = fixture.tasks.get(scope)?.find(task => task.book_id === bookId);
    if (!task) return Response.json({ detail: '任务不存在' }, { status: 404 });
    task.status = 'ready'; task.progress = 100;
    return Response.json({ task_id: task.id, book_id: bookId, status: 'ready' });
  }
  if (path.endsWith('/translations/notifications')) return Response.json({ active_count: 0, unread_count: 0, items: [] });
  if (path.endsWith('/books/source-updates')) return Response.json({ book_count: 0, episode_count: 0, items: [] });
  if (path.endsWith('/auth/me/ai-settings')) return Response.json({ api_key_configured: false, provider_base_url: '', translation_model: '', translation_prompt: '', translation_concurrency: 2, audiobook_api_key_configured: false, audiobook_provider_base_url: '', audiobook_tts_model: '', audiobook_tts_voice: '' });
  if (path.endsWith('/ai-channels/translation-models')) return Response.json([]);
  if (path.endsWith('/translations')) {
    if (options?.method === 'POST') {
      fixture.translationSubmissions.push(JSON.parse(options.body));
      if (fixture.translationSubmitStatus !== 200) return Response.json({ detail: fixture.diagnostic }, { status: fixture.translationSubmitStatus });
      const job = { ...fixture.translationJobs[0], id: 'accepted-submission', title: '已确认提交的译稿', status: 'queued', error_message: null };
      fixture.translationJobs.unshift(job);
      return Response.json(job);
    }
    return Response.json(structuredClone(fixture.translationJobs));
  }
  const action = path.match(/\/translations\/([^/]+)(?:\/(resume|pause|retry|concurrency))?$/);
  if (action) {
    const job = fixture.translationJobs.find(job => job.id === action[1]), status = fixture.translationActionStatus;
    const record = { path, method: options?.method, aborted: false };
    fixture.translationActions.push(record);
    options?.signal?.addEventListener('abort', () => { record.aborted = true; }, { once: true });
    if (fixture.holdTranslationActions) await new Promise(resolve => fixture.pendingTranslationActions.push({ resolve }));
    if (status !== 200) return Response.json({ detail: fixture.diagnostic }, { status });
    if (!job) return Response.json({ detail: 'Task not found' }, { status: 404 });
    if (options?.method === 'DELETE') {
      fixture.translationJobs = fixture.translationJobs.filter(candidate => candidate !== job);
      return Response.json({ deleted: 1 });
    }
    if (action[2] === 'concurrency') job.request_concurrency = JSON.parse(options.body).request_concurrency;
    else if (action[2] === 'pause') job.pause_requested = true;
    else { job.message = '已加入队列，等待继续翻译'; job.status = 'queued'; job.pause_requested = false; job.error_message = null; }
    return Response.json(structuredClone(job));
  }
  return Response.json({});
};
window.XMLHttpRequest = class {
  upload = {};
  headers = {};
  status = 0;
  responseType = '';
  aborted = false;
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(key, value) { this.headers[key] = value; }
  abort() { this.aborted = true; this.onabort?.(); }
  async send(form) {
    const scope = getAccountScope(), file = form.get('file');
    const record = { scope, headers: this.headers, content: await file.text(), title: form.get('title'), fileName: file.name };
    fixture.uploads.push(record);
    if (fixture.holdUpload) await new Promise(resolve => fixture.pendingUploads.push(resolve));
    if (this.aborted) return;
    this.status = fixture.fileStatuses[file.name] ?? fixture.uploadStatus;
    const id = 'draft-upload-' + (fixture.uploads.indexOf(record) + 1);
    if (this.status === 200) fixture.tasks.set(scope, [{ id, book_id: id + '-book', file_name: file.name, file_size: file.size, file_type: 'TXT', status: fixture.acceptedStatus, progress: fixture.acceptedStatus === 'ready' ? 100 : 0, message: '已保存', error_code: null }, ...(fixture.tasks.get(scope) || [])]);
    this.responseText = JSON.stringify(this.status === 200 ? { task_id: id, book_id: id + '-book', status: fixture.acceptedStatus } : { detail: '模拟上传失败，请重试' });
    this.upload.onload?.(); this.onload?.();
  }
};
const noop = async () => {};
function FixtureSession({ children }) {
  const [current, update] = React.useState(session);
  fixture.switchAccount = (id) => { const next = { ...session, id }; setStoredSession(next); update(next); };
  return <SessionContext.Provider value={{ session: current, isLoading: false, logout: noop, login: async () => current, registerWithInvitation: async () => current, updateNickname: noop, updateAvatar: noop, changePassword: noop }}>{children}</SessionContext.Provider>;
}
function Probe() { const navigate = useNavigate(); fixture.navigate = navigate; return null; }
const tree = <FixtureSession><MemoryRouter initialEntries={['/upload']}><Probe /><ThemeProvider><Routes><Route element={<AppLayout />}><Route path="/upload" element={<UploadPage />} /><Route path="/draft-away" element={<main><Link id="reopen" to="/upload">返回上传页</Link></main>} /></Route></Routes></ThemeProvider></MemoryRouter></FixtureSession>;
createRoot(document.getElementById('root')).render(query.has('strict') ? <React.StrictMode>{tree}</React.StrictMode> : tree);
