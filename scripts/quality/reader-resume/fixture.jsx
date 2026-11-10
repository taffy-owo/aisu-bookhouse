import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { SessionContext } from '../../../src/app/SessionContext';
import { AppLayout } from '../../../src/app/AppLayout';
import { ThemeProvider } from '../../../src/shared/theme/ThemeProvider';
import { RouteScrollRestoration } from '../../../src/app/RouteScrollRestoration';
import { NovelReaderPage } from '../../../src/modules/reader/pages/NovelReaderPage';
import { MangaReaderPage } from '../../../src/modules/reader/pages/MangaReaderPage';
import { ReaderErrorBoundary } from '../../../src/modules/reader/components/ReaderErrorBoundary';
import { ReaderStartupState } from '../../../src/modules/reader/components/ReaderStartupState';
import { BookDetailPage } from '../../../src/modules/library/pages/BookDetailPage';
import { DEFAULT_READER_PREFERENCES } from '../../../src/modules/reader/services/readerPreferences';
import { flushReadingProgressSync } from '../../../src/modules/reader/services/readingProgressSync';
import { readStoredPendingProgress } from '../../../src/modules/reader/services/pendingProgressStorage';
import { readChapterPositionHistory } from '../../../src/modules/reader/services/chapterPositionHistory';
import { getAccountScope, getStoredSession, setStoredSession } from '../../../src/shared/api';
import { createPdfFixture } from './pdf-fixture.mjs';
import '../../../src/index.css';

const isFixtureEntry = location.pathname.endsWith('/fixture.html');
if (isFixtureEntry) sessionStorage.setItem('resume-options', location.search);
const query = new URLSearchParams(sessionStorage.getItem('resume-options') || '');
if (query.has('silentAudiobook')) {
  // Exercise the real player layout without speaking or advancing the text.
  // The production default is the free quality voice; this fixture explicitly
  // selects device speech so the failure-state layout remains deterministic.
  localStorage.setItem('aisu-bookhouse:audiobook-mode', 'instant');
  localStorage.setItem('aisu-bookhouse:instant-audiobook-preferences', JSON.stringify({ autoAdvance: false, followText: false, playbackRate: 1, voiceUri: '' }));
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => [], cancel() {}, addEventListener() {}, removeEventListener() {},
    speak() { throw new Error('模拟设备语音暂不可用'); },
  } });
}
const readableMedia = query.has('readableManga') || query.has('readableImage');
const entryPath = query.has('detail') ? '/books/resume-test' : `/reader/${query.has('manga') || readableMedia ? 'manga' : 'novel'}/resume-test`;
const navigationState = query.has('collection') ? { collectionReturn: { pathname: query.get('collection') === 'public' ? '/public' : '/library', search: '?q=test&sort=recent', key: 'source-collection' } } : undefined;
if (isFixtureEntry) {
  // Seed a real detail -> reader history. Browser back, chapter URL rewrites,
  // and full reloads must follow the same paths as the production application.
  if (query.has('direct')) history.replaceState({ usr: navigationState }, '', entryPath);
  else {
    history.replaceState(null, '', query.has('detail') ? '/library' : '/books/resume-test');
    history.pushState({ usr: navigationState }, '', entryPath);
  }
}
const session = { id: 'resume-test-user', nickname: '续读测试', role: 'user' };
if (query.has('siteDark')) document.documentElement.classList.add('dark');
if (query.has('detail')) localStorage.setItem('aisu-theme', query.has('siteDark') ? 'dark' : 'light');
setStoredSession(session);
if (!query.has('persistPreferences') || isFixtureEntry || !localStorage.getItem('aisu-bookhouse:reader-preferences')) localStorage.setItem('aisu-bookhouse:reader-preferences', JSON.stringify({ ...DEFAULT_READER_PREFERENCES, theme: query.get('theme') || 'dark', readingMode: query.has('paged') ? 'paged' : 'scroll' }));
const catalogLength = Math.max(3, Math.min(2000, Number(query.get('catalogLength')) || 3));
const mediaPageCount = Math.max(3, Math.min(4000, Number(query.get('mediaPageCount')) || 3));
const book = { id: 'resume-test', title: '续读回归用书', author: '测试', kind: 'novel', reader_type: 'epub', language: 'zh', status: 'ready', progress_percent: 0, publication_status: 'completed', chapter_count: catalogLength, character_count: 10000, tags: [], description: '', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', is_owned: true, file_ext: 'epub', file_size: 10000 };
const resource = { reader_type: 'epub', chapter_count: catalogLength, toc: Array.from({ length: catalogLength }, (_, i) => i + 1).map(index => ({ index, title: `第${index}话`, position_key: `key-${index}`, progress_weight: 1 })), pages: [] };
if (query.has('actionLong')) Object.assign(book, { title: 'long_book_title_'.repeat(28), public_status: 'private', public_download_allowed: false });
if (query.has('dialogLong')) Object.assign(book, { tags: ['long_tag_'.repeat(30)], description: '简介中保留的内容。'.repeat(30) });
if (query.has('detailProgress')) { book.progress_percent = Number(query.get('detailProgress')); resource.toc[0].progress_weight = 8; }
if (query.has('emptyCatalog')) { book.chapter_count = resource.chapter_count = 0; resource.toc = []; }
if (query.has('publicDetail')) book.is_owned = false;
if (query.has('bookStatus')) book.status = query.get('bookStatus');
if (query.has('textBook')) book.reader_type = resource.reader_type = 'text';
if (query.has('manga') || readableMedia || query.has('unsupported') || query.has('pdf')) {
  book.reader_type = query.has('readableImage') ? 'image' : query.has('manga') || readableMedia ? 'comic' : query.has('pdf') ? 'pdf' : 'unsupported';
  book.file_ext = book.reader_type === 'pdf' ? 'pdf' : 'bin';
  Object.assign(resource, { reader_type: book.reader_type, chapter_count: 0, toc: [], page_count: 0 });
  if (query.has('pdf')) Object.assign(resource, { position_key: 'fixture-pdf', file_url: '/api/v1/files/books/resume-test/fixture.pdf' });
  if (readableMedia) Object.assign(resource, { page_count: mediaPageCount, pages: Array.from({ length: mediaPageCount }, (_, i) => i + 1).map(index => ({ index, position_key: `image-${index}`, image_url: `/api/v1/files/books/resume-test/page-${(index - 1) % 3 + 1}.svg` })) });
  if (query.has('unsupported')) book.chapter_count = 0;
}
if(query.has('chapterUpdates'))resource.toc.forEach(item=>{item.content_version='initial-'+item.index;});
const chapterOrder = Array.from({ length: catalogLength }, (_, i) => i + 1);
const makeChapter = (index) => {
  const source = chapterOrder[index - 1];
  return { index, ...(query.has('chapterUpdates')?{content_version:'initial-'+source}:{}), title: `第${source}话`, position_key: `key-${source}`, content: Array.from({ length: 160 }, (_, i) => `第${source}话第${i + 1}段。窗外的雨渐渐停了，她将信纸铺在桌面，一行一行地读下去。故事还很长，今晚可以慢慢读。`).join('\n\n'), ...fixture.chapterEdits.get(source) };
};
let progress = JSON.parse(sessionStorage.getItem('resume-server') || 'null') || { book_id: book.id, reader_type: book.reader_type, chapter_index: book.reader_type === 'epub' ? 1 : null, position_key: 'key-1', epub_cfi: book.reader_type === 'epub' ? 'aisu-scroll:0' : null, progress_percent: 0, updated_at: '2026-10-01T00:00:00Z' };
if (query.has('detailProgress')) Object.assign(progress, { progress_percent: Number(query.get('detailProgress')), epub_cfi: 'aisu-scroll:0.75' });
if (readableMedia && !sessionStorage.getItem('resume-server')) Object.assign(progress, { image_index: 1, position_key: 'image-1', progress_percent: 33 });
if (query.has('initialChapter')) { const index = Math.min(catalogLength, Math.max(1, Number(query.get('initialChapter')))); Object.assign(progress, { chapter_index: index, position_key: `key-${index}`, progress_percent: Math.round((index - 1) * 100 / catalogLength) }); }
if (readableMedia && query.has('initialPage')) { const index = Math.min(mediaPageCount, Math.max(1, Number(query.get('initialPage')))); Object.assign(progress, { image_index: index, position_key: `image-${index}`, progress_percent: Math.round(index * 100 / mediaPageCount) }); }
if (query.has('pdfPages') && isFixtureEntry) Object.assign(progress, { page_number: Number(query.get('initialPage') || 1), position_key: 'fixture-pdf', progress_percent: 0 });
if (query.has('appendedProgress')) {
  resource.toc.forEach((item, index) => { item.progress_weight = index < 120 ? 1000 : 1800; });
  const finished = query.get('appendedProgress') === 'finished';
  book.progress_percent = finished ? 100 : 46;
  Object.assign(progress, { chapter_index: 121, position_key: 'key-121', epub_cfi: 'aisu-scroll:0.16', progress_percent: book.progress_percent });
  if (isFixtureEntry && !finished) localStorage.setItem('aisu-bookhouse:pending-reading-progress:resume-test-user', JSON.stringify({
    'resume-test': { bookId: book.id, readerType: 'epub', chapterIndex: 121, positionKey: 'key-121',
      epubCfi: 'aisu-scroll:0.16', progressPercent: 100, updatedAt: new Date().toISOString() },
  }));
}
if (query.has('catalogMutationProgress')) {
  resource.toc.forEach((item, index) => { item.progress_weight = [100, 1600, 100, 100][index]; });
  const last = query.get('catalogMutationProgress') === 'last';
  Object.assign(progress, { chapter_index: last ? 4 : 2, position_key: last ? 'key-4' : 'key-2',
    epub_cfi: last ? 'aisu-scroll:0.4' : 'aisu-scroll:0.75', progress_percent: last ? 97 : 68 });
  book.progress_percent = progress.progress_percent;
}
function weightedFixturePercent() {
  const index = progress.chapter_index, ratio = Number(progress.epub_cfi.split(':')[1]);
  const weights = resource.toc.map(item => item.progress_weight);
  const raw = (weights.slice(0, index - 1).reduce((a, b) => a + b, 0) + weights[index - 1] * ratio) / weights.reduce((a, b) => a + b, 0) * 100;
  return index === weights.length && ratio === 1 ? 100 : Math.min(99, Math.max(0, Math.round(raw)));
}
const fixture = {
  book, resource,
  actionRequests: [], actionStatus: {}, holdActions: {}, pendingActions: [],
  actionError: '操作暂时失败，请保留输入后重试。\n' + 'diagnostic_details_'.repeat(30),
  replacementTaskStatus: 'ready', replacementReadStatus: 0, replacementReads: [], acceptedReplacementStatus: 'processing',
  bookMutations: [], mutationStatus: 0, holdMutation: false, pendingMutations: [],
  metadataReads: [], metadataStatus: 0, holdMetadata: false, pendingMetadata: [],
  writes: [], attempts: [], pendingWrites: [], readingStatusWrites: [],
  pendingChapters: [], holdWrites: query.has('holdWrites'),
  holdChapter: query.has('holdChapter') ? Number(query.get('holdChapter') || 2) : 0, failChapter: query.has('failChapter') ? Number(query.get('failChapter') || 2) : 0,
  errorMessage: '模拟目标正文加载失败',
  startupStatus: Number(query.get('startupError') || 0), holdStartup: query.has('holdStartup'), pendingStartups: [], startupRequests: [],
  startupMessage: query.has('longError') ? '连接暂时中断，请稍后重试。'.repeat(40) + 'x'.repeat(320) : '模拟阅读器暂时无法连接，请稍后重试。',
  holdDownload: query.has('holdDownload'), pendingDownloads: [], downloadRequests: 0,
  failure: query.get('crash') || '', caughtErrors: [], loggedBoundaryErrors: [],
  editorStatus: {}, editorMessage: '', holdEditor: {}, pendingEditors: [], editorRequests: [], chapterEdits: new Map(), editorReceipts: new Map(), resourceStatus: 0,
  detailStatus: { resource: Number(query.get('resourceError') || 0), chapters: Number(query.get('chaptersError') || 0), progress: Number(query.get('progressError') || 0) }, detailReads: [], holdDetail: {}, pendingDetails: [],
  markStatus: {}, holdMarks: {}, pendingMarks: [], markRequests: [], marksByAccount: new Map(JSON.parse(sessionStorage.getItem('resume-marks-server') || '[]')), markSequence: Number(sessionStorage.getItem('resume-mark-sequence') || 0),
  marks: () => fixture.marksByAccount.get(getAccountScope()) || [],
  progress: () => progress, flush: () => flushReadingProgressSync(book.id),
};
if (query.has('persistEditor')) {
  const saved = JSON.parse(sessionStorage.getItem('resume-chapters-server') || 'null');
  if (saved) {
    chapterOrder.splice(0, chapterOrder.length, ...saved.order);
    Object.assign(resource, saved.resource);
    book.chapter_count = resource.chapter_count;
    fixture.chapterEdits = new Map(saved.edits);
    fixture.editorReceipts = new Map(saved.receipts);
    fixture.editorRequests = saved.requests;
  }
}
function storeFixtureChapterServer() {
  if (query.has('persistEditor')) sessionStorage.setItem('resume-chapters-server', JSON.stringify({
    order: chapterOrder, resource, edits: [...fixture.chapterEdits], receipts: [...fixture.editorReceipts], requests: fixture.editorRequests,
  }));
}
const reviewJob = { id: 'review-job', book_id: book.id, job_kind: 'source_update', title: '来信的新篇章', author: '测试', status: 'review', stage: 'review', acknowledged: false, total_chapters: 3, completed_chapters: 3, progress: 100, updated_at: '2026-11-01T00:00:00Z', created_at: '2026-11-01T00:00:00Z', finished_at: null, message: '译稿已完成，等待审核', error_message: null, quality_status: 'passed', quality_issue_count: 0, channel_id: null, channel_name: '测试通道', model: 'test-model', request_concurrency: 2, max_concurrency: 4, pause_requested: false, quota_resume_at: null, current_chapter_index: null, source_provider: 'kakuyomu', source_url: 'https://kakuyomu.jp/works/123' };
const review = { book_id: book.id, job_id: reviewJob.id, title: query.has('reviewLong') ? 'review_title_'.repeat(26) : reviewJob.title, status: 'review', chapters: Array.from({ length: 3 }, (_, i) => ({ index: i + 1, title: query.has('reviewLong') ? 'chapter_title_'.repeat(20) + (i + 1) : '新篇章 第' + (i + 1) + '话', source_title: '原作第' + (i + 1) + '话', source_url: 'https://kakuyomu.jp/works/123/episodes/' + (i + 1), content: Array.from({ length: 60 }, (_, p) => '第' + (i + 1) + '话第' + (p + 1) + '段。窗外的雨渐渐停了，她展开刚收到的来信。').join('\n\n') })) };
Object.assign(fixture, { reviewJob, review, reviewRequests: [], reviewStatus: {}, holdReview: {}, pendingReviews: [], reviewError: '模拟译稿操作失败，当前预览已保留。\n' + 'diagnostic_detail_'.repeat(40), confirmedReview: true, confirmCalls: [] });
if (query.has('translationReview')) window.confirm = message => { fixture.confirmCalls.push(message); return fixture.confirmedReview; };
Object.assign(window, { resumeFixture: fixture });
async function chapterRevision(index) {
  const chapter = makeChapter(index);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([chapterOrder[index - 1], chapter.title, chapter.content])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function storeFixtureMarks(scope, marks) {
  fixture.marksByAccount.set(scope, marks);
  sessionStorage.setItem('resume-marks-server', JSON.stringify([...fixture.marksByAccount]));
  sessionStorage.setItem('resume-mark-sequence', String(fixture.markSequence));
}
const isFixtureError = error => error instanceof Error && (error.message === 'Reader fixture render failure' || error.message === 'Failed to fetch dynamically imported module: /assets/reader-fixture.js');
const nativeConsoleError = console.error.bind(console);
console.error = (...args) => {
  if (args[0] === 'Aisu page render failed' && isFixtureError(args[1])) fixture.loggedBoundaryErrors.push(args[1].message);
  else nativeConsoleError(...args);
};
if (query.has('assetCooldown')) sessionStorage.setItem('aisu.asset-reload-at', String(Date.now()));
if (query.has('offline')) Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, options) => {
  const url = new URL(String(input), location.origin), p = url.pathname;
  if (!p.startsWith('/api/v1')) return nativeFetch(input, options);
  const detailRead = async (operation) => {
    const request = { operation, scope: getAccountScope(), signal: options?.signal };
    fixture.detailReads.push(request);
    if (fixture.holdDetail[operation]) await new Promise(resolve => fixture.pendingDetails.push({ ...request, resolve }));
    if (fixture.detailStatus[operation] === -1) throw new TypeError('Failed to fetch');
    return fixture.detailStatus[operation] ? Response.json({ detail: `模拟详情${operation}读取失败` }, { status: fixture.detailStatus[operation] }) : null;
  };
  if ((p === '/api/v1/books/resume-test' && options?.method === 'DELETE') || p.endsWith('/share-request')) {
    const operation = p.endsWith('/share-request') ? options?.method === 'DELETE' ? 'unshare' : 'share' : 'delete';
    const request = { operation, method: options.method, body: options.body ? JSON.parse(String(options.body)) : null, signal: options.signal };
    fixture.actionRequests.push(request);
    if (fixture.holdActions[operation]) await new Promise(resolve => fixture.pendingActions.push({ operation, resolve }));
    if (fixture.actionStatus[operation] === -1) throw new TypeError('Failed to fetch');
    if (fixture.actionStatus[operation]) return Response.json({ detail: fixture.actionError }, { status: fixture.actionStatus[operation] });
    if (operation === 'share') Object.assign(book, { public_status: 'pending', public_share_note: request.body.share_note, public_source_note: request.body.source_note, public_download_allowed: request.body.public_download_allowed });
    if (operation === 'unshare') book.public_status = 'private';
    return operation === 'delete' ? new Response(null, { status: 204 }) : Response.json(book);
  }
  if (p.startsWith('/api/v1/uploads/tasks/')) {
    fixture.replacementReads.push({ taskId: p.split('/').at(-1), signal: options?.signal });
    if (fixture.replacementReadStatus) return Response.json({ detail: '暂时无法读取替换任务' }, { status: fixture.replacementReadStatus });
    if (fixture.replacementTaskStatus === 'ready' || fixture.replacementTaskStatus === 'failed') book.status = 'ready';
    return Response.json({ id: p.split('/').at(-1), book_id: book.id, file_name: 'replacement.txt', file_size: 40, file_type: 'TXT', status: fixture.replacementTaskStatus, progress: 100, message: fixture.replacementTaskStatus === 'failed' ? '新文件解析失败，旧版本已恢复' : '完成' });
  }
  if (query.has('translationReview') && /^\/api\/v1\/translations\/review-job\/(review|accept|reject)$/.test(p)) {
    const operation = p.split('/').at(-1), request = { operation, method: options?.method || 'GET', signal: options?.signal };
    fixture.reviewRequests.push(request);
    if (fixture.holdReview[operation]) await new Promise(resolve => fixture.pendingReviews.push({ ...request, resolve }));
    const status = fixture.reviewStatus[operation] || 0;
    if (status === -1) throw new TypeError('Failed to fetch');
    if (status) return Response.json({ detail: fixture.reviewError }, { status });
    if (operation === 'review') return Response.json(fixture.review);
    fixture.reviewJob.status = fixture.review.status = operation === 'accept' ? 'ready' : 'rejected';
    return Response.json(fixture.reviewJob);
  }
  if (p === '/api/v1/books') return Response.json({ items: [book], page: 1, page_size: 100, total: 1, has_more: false });
  if (p === '/api/v1/uploads/source-metadata') {
    const body = JSON.parse(String(options.body));
    const request = { url: body.url, signal: options.signal };
    fixture.metadataReads.push(request);
    if (fixture.holdMetadata) await new Promise(resolve => fixture.pendingMetadata.push({ ...request, resolve }));
    if (fixture.metadataStatus) return Response.json({ detail: '原作读取暂时失败，请稍后重试。' }, { status: fixture.metadataStatus });
    return Response.json({ title: 'source_title_'.repeat(30), original_title: '原作名', author: 'source_author_'.repeat(20), description: '从原作读取的简介。', tags: ['source_tag_'.repeat(30)], source: 'kakuyomu', source_url: body.url, episode_count: 80, character_count: 120000, publication_status: 'ongoing', translation_status: 'translated', schedule_label: 'long_schedule_'.repeat(24) });
  }
  if ((p === '/api/v1/books/resume-test' && options?.method === 'PATCH') || (p.endsWith('/cover') && ['PUT','DELETE'].includes(options?.method))) {
    const cover = p.endsWith('/cover');
    const body = cover ? { name: options?.body?.get?.('file')?.name, size: options?.body?.get?.('file')?.size } : JSON.parse(String(options.body));
    fixture.bookMutations.push({ body, method: options.method, cover, signal: options.signal });
    if (fixture.holdMutation) await new Promise(resolve => fixture.pendingMutations.push(resolve));
    if (fixture.mutationStatus) return Response.json({ detail: '保存暂时失败，修改已保留。' + '诊断详情_'.repeat(60) }, { status: fixture.mutationStatus });
    if (cover) book.cover_url = options.method === 'DELETE' ? null : '/api/v1/files/books/resume-test/page-1.svg?custom=1';
    else Object.assign(book, body);
    return Response.json(book);
  }
  if (p.endsWith('/books/source-updates')) return Response.json({ book_count: 0, episode_count: 0, items: [] });
  if (p.endsWith('/translations/notifications')) return Response.json({ active_count: 0, unread_count: 0, items: [] });
  if (p.endsWith('/translation-jobs')) return Response.json(query.has('translationReview') ? [fixture.reviewJob] : []);
  if (p.endsWith('/reading-status') && options?.method === 'PUT') {
    const body = JSON.parse(String(options.body));
    fixture.readingStatusWrites.push(body);
    book.progress_percent = body.finished ? 100 : 0;
    book.updated_at = body.updated_at;
    progress = body.finished ? { ...progress, progress_percent: 100, updated_at: body.updated_at }
      : { book_id: book.id, reader_type: book.reader_type, progress_percent: 0, updated_at: body.updated_at };
    sessionStorage.setItem('resume-server', JSON.stringify(progress));
    return Response.json({ ...book, reading_progress: progress });
  }
  if (p.endsWith('/chapters') && (!options?.method || options.method === 'GET')) {
    const snapshot = resource.toc.map(({ index, title }) => ({ index, title }));
    return await detailRead('chapters') || Response.json(snapshot);
  }
  if ((/\/chapters\/\d+(?:\/edit)?$/.test(p) || (p.endsWith('/chapters') && options?.method === 'POST')) && !p.includes('/reader/')) {
    const operation = p.endsWith('/chapters') ? 'append' : p.endsWith('/edit') ? 'load' : options?.method === 'DELETE' ? 'remove' : 'save';
    const index = operation === 'append' ? chapterOrder.length + 1 : Number(p.split('/').at(operation === 'load' ? -2 : -1));
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    const requestHeaders = new Headers(options?.headers);
    const requestId = requestHeaders.get('Idempotency-Key'), revision = requestHeaders.get('If-Match');
    const receiptKey = getAccountScope() + ':' + requestId;
    const digest = JSON.stringify([operation, operation === 'append' ? null : index, body, revision]);
    fixture.editorRequests.push({ operation, index, body, scope: getAccountScope(), signal: options?.signal, requestId, revision });
    storeFixtureChapterServer();
    if (fixture.holdEditor[operation]) await new Promise(resolve => fixture.pendingEditors.push({ operation, resolve }));
    const previous = requestId && fixture.editorReceipts.get(receiptKey);
    if (previous) return previous.digest === digest ? Response.json(previous.result) : Response.json({ detail: '请求身份已用于另一项操作' }, { status: 409 });
    if (fixture.editorStatus[operation] === -1) throw new TypeError('Failed to fetch');
    if (fixture.editorStatus[operation] > 0) return Response.json({ detail: fixture.editorMessage || `模拟章节${operation === 'load' ? '加载' : '保存'}失败，请重试。` }, { status: fixture.editorStatus[operation] });
    if (operation !== 'append' && !chapterOrder[index - 1]) return Response.json({ detail: 'Chapter not found' }, { status: 404 });
    if (operation === 'load') return Response.json({ ...makeChapter(index), revision: await chapterRevision(index), format: 'epub', has_images: query.has('editableImages') });
    if (operation !== 'append' && revision !== '"' + await chapterRevision(index) + '"') return Response.json({ detail: '章节已被修改或重新排序，本次操作未执行。请保留草稿，重新打开章节核对。' }, { status: 412 });
    const committed = (result) => {
      if (requestId) fixture.editorReceipts.set(receiptKey, { digest, result });
      storeFixtureChapterServer();
      if (fixture.editorStatus[operation] === -2) throw new TypeError('Failed to fetch after commit');
      return Response.json(result);
    };
    if (operation === 'append') {
      const source = Math.max(...chapterOrder, 0) + 1;
      chapterOrder.push(source);
      fixture.chapterEdits.set(source, { content: body.content, title: body.title || `第${index}话` });
      book.chapter_count = resource.chapter_count = chapterOrder.length;
      resource.toc.push({ index, title: fixture.chapterEdits.get(source).title, position_key: `key-${source}`, progress_weight: 1 });
      return committed({ chapter_count: chapterOrder.length, index, text_length: body.content.length, title: fixture.chapterEdits.get(source).title });
    }
    if (operation === 'remove') {
      const oldToc = resource.toc, oldProgress = progress;
      chapterOrder.splice(index - 1, 1);
      book.chapter_count = resource.chapter_count = chapterOrder.length;
      resource.toc = chapterOrder.map((source, i) => ({ index: i + 1, title: fixture.chapterEdits.get(source)?.title || `第${source}话`, position_key: `key-${source}`, progress_weight: 1 }));
      const next = progress.chapter_index > index ? progress.chapter_index - 1 : Math.min(progress.chapter_index, chapterOrder.length);
      const cfi = progress.chapter_index === index ? null : progress.epub_cfi;
      const ratio = cfi ? Number(cfi.split(':')[1]) : 0;
      progress = { ...progress, chapter_index: next, position_key: resource.toc[next - 1].position_key, epub_cfi: cfi, progress_percent: ((next - 1 + ratio) / chapterOrder.length) * 100, updated_at: new Date().toISOString() };
      if (query.has('catalogMutationProgress')) {
        resource.toc.forEach(item => { item.progress_weight = oldToc.find(old => old.position_key === item.position_key).progress_weight; });
        progress.epub_cfi = oldProgress.chapter_index === index ? `aisu-scroll:${index <= chapterOrder.length ? 0 : 1}` : oldProgress.epub_cfi;
        progress.updated_at = oldProgress.updated_at;
        book.progress_percent = progress.progress_percent = weightedFixturePercent();
      }
      sessionStorage.setItem('resume-server', JSON.stringify(progress));
      return committed({ chapter_count: chapterOrder.length, deleted_index: index, next_index: Math.min(index, chapterOrder.length) });
    }
    fixture.chapterEdits.set(chapterOrder[index - 1], { content: body.content, title: body.title });
    resource.toc[index - 1].title = body.title;
    if (query.has('catalogMutationProgress')) {
      resource.toc[index - 1].progress_weight = body.content.length;
      book.progress_percent = progress.progress_percent = weightedFixturePercent();
    }
    return committed({ chapter_count: chapterOrder.length, index, text_length: body.content.length, title: body.title });
  }
  if (/\/marks(?:\/[^/]+(?:\/position)?)?$/.test(p)) {
    const method = options?.method || 'GET';
    const operation = method === 'GET' ? 'load' : method === 'POST' ? 'create' : method === 'DELETE' ? 'remove' : 'relocate';
    const scope = getAccountScope(), snapshot = [...(fixture.marksByAccount.get(scope) || [])];
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    fixture.markRequests.push({ operation, scope, body, signal: options?.signal });
    if (fixture.holdMarks[operation]) await new Promise(resolve => fixture.pendingMarks.push({ operation, resolve }));
    if (fixture.markStatus[operation]) return Response.json({ detail: `模拟标记${operation === 'load' ? '加载' : operation === 'create' ? '保存' : operation === 'remove' ? '删除' : '定位'}失败，请重试。` }, { status: fixture.markStatus[operation] });
    const current = fixture.marksByAccount.get(scope) || [];
    if (operation === 'load') return Response.json(snapshot);
    const id = operation === 'create' ? `fixture-mark-${++fixture.markSequence}` : p.split('/').at(operation === 'relocate' ? -2 : -1);
    if (operation === 'remove') {
      storeFixtureMarks(scope, current.filter(mark => mark.id !== id));
      return new Response(null, { status: 204 });
    }
    const previous = current.find(mark => mark.id === id);
    const confirmed = { ...(previous || {}), ...body, id, book_id: book.id, position_valid: true, created_at: previous?.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
    storeFixtureMarks(scope, [...current.filter(mark => mark.id !== id), confirmed]);
    return Response.json(confirmed);
  }
  if (/\/page-\d\.svg$/.test(p)) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="' + (query.has('longStrip') ? 3000 : 800) + '"><rect width="600" height="' + (query.has('longStrip') ? 3000 : 800) + '" fill="#e7d8cb"/><text x="240" y="400" font-size="60">' + p.match(/page-(\d)/)[1] + '</text></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
  if (p.endsWith('/progress') && options?.method === 'PUT') {
    const body = JSON.parse(String(options.body)); fixture.attempts.push(body);
    if (fixture.holdWrites) await new Promise(resolve => fixture.pendingWrites.push(resolve));
    progress = { ...progress, ...body }; fixture.writes.push(body);
    sessionStorage.setItem('resume-server', JSON.stringify(progress));
    return Response.json(progress);
  }
  if (p.includes('/reader/chapters/')) {
    if(query.has('chapterUpdates'))fixture.chapterReads=(fixture.chapterReads||0)+1;
    const index = Number(p.split('/').at(-1));
    const snapshot = fixture.chapterSnapshotBeforeHold ? makeChapter(index) : null;
    if (fixture.holdChapter === index) await new Promise(resolve => fixture.pendingChapters.push(resolve));
    if (fixture.failChapter === index) return Response.json({ detail: fixture.errorMessage }, { status: 503 });
    return Response.json(snapshot ?? makeChapter(index));
  }
  if (p.endsWith('/reader/startup')) {
    const index = Number(url.searchParams.get('chapter_index') || progress.chapter_index);
    const response = { book, resource, chapter: book.reader_type === 'epub' ? makeChapter(index) : null, progress: { ...progress }, marks: [...fixture.marks()] };
    fixture.startupRequests.push({ path: p, chapterIndex: index, signal: options?.signal });
    if (fixture.holdStartup) await new Promise(resolve => fixture.pendingStartups.push(resolve));
    if (fixture.startupStatus === -1) throw new TypeError('Failed to fetch');
    if (fixture.startupStatus) return Response.json({ detail: fixture.startupMessage }, { status: fixture.startupStatus });
    if (book.reader_type === 'epub' && !chapterOrder[index - 1]) return Response.json({ detail: 'Chapter not found' }, { status: 404 });
    return Response.json(response);
  }
  if (p.endsWith('/download-ticket')) {
    fixture.downloadRequests++;
    if (fixture.holdDownload) await new Promise(resolve => fixture.pendingDownloads.push(resolve));
    return Response.json({ detail: '下载准备暂时失败，请重试。' + (query.has('longError') ? 'x'.repeat(1200) : '') }, { status: 503 });
  }
  if (p.endsWith('/fixture.pdf')) {
    if (query.has('pdfPages')) {
      const pdf = createPdfFixture(Math.max(1, Math.min(200, Number(query.get('pdfPages')) || 64)), query.has('pdfScan'));
      return new Response(pdf, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length) } });
    }
    const text = 'BT /F1 16 Tf 60 700 Td (Reader startup fixture) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new Response(pdf, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length) } });
  }
  if (p.endsWith('/reader')) {
    const snapshot = structuredClone(resource);
    return await detailRead('resource') || (fixture.resourceStatus ? Response.json({ detail: '模拟目录刷新失败' }, { status: fixture.resourceStatus }) : Response.json(snapshot));
  }
  if (p.endsWith('/progress')) {
    const snapshot = structuredClone(progress);
    return (query.has('detail') ? await detailRead('progress') : null) || Response.json(snapshot);
  }
  if (p.endsWith('/marks') || p.endsWith('/ai-channels')) return Response.json([]);
  if (p === '/api/v1/books/resume-test') {
    const snapshot = structuredClone(book);
    return await detailRead('book') || Response.json(snapshot);
  }
  return Response.json(book);
};
if (query.has('actionLong')) window.XMLHttpRequest = class {
  upload = {}; headers = {}; status = 0; responseText = ''; aborted = false;
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(key, value) { this.headers[key] = value; }
  abort() { this.aborted = true; this.onabort?.(); }
  async send(form) {
    const file = form.get('file');
    fixture.actionRequests.push({ operation: 'replace', method: this.method, url: this.url, fileName: file.name, content: await file.text(), keepProgress: form.get('keep_progress') });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    if (fixture.holdActions.replace) await new Promise(resolve => fixture.pendingActions.push({ operation: 'replace', resolve }));
    if (this.aborted) return;
    this.status = fixture.actionStatus.replace || 200;
    if (this.status === -1) { this.onerror?.(); return; }
    if (this.status === 200) book.status = fixture.acceptedReplacementStatus === 'ready' ? 'ready' : 'processing';
    this.responseText = JSON.stringify(this.status === 200 ? { task_id: 'replacement-fixture-task', book_id: book.id, status: fixture.acceptedReplacementStatus } : { detail: fixture.actionError });
    this.upload.onload?.(); this.onload?.();
  }
};

function Probe() {
  const navigate = useNavigate();
  Object.assign(window, { fixtureNavigate: navigate });
  fixture.pendingProgress = () => Object.fromEntries(readStoredPendingProgress('aisu-bookhouse:pending-reading-progress:' + getStoredSession().id));
  fixture.chapterHistory = () => readChapterPositionHistory();
  return null;
}
const noop = async () => {};
const value = { session, isLoading: false, logout: noop, updateNickname: noop, updateAvatar: noop, changePassword: noop, login: async () => session, registerWithInvitation: async () => session };
function FixtureSession({ children }) {
  const [current, setCurrent] = React.useState(session);
  fixture.switchAccount = (id) => { const next = { ...session, id }; setStoredSession(next); setCurrent(next); };
  return <SessionContext.Provider value={{ ...value, session: current }}>{children}</SessionContext.Provider>;
}
function Destination({ collection = false }) { const location = useLocation(); return <main style={{ padding: 40 }}><Link id={collection ? 'collection-return' : 'reopen'} state={location.state} to={entryPath}>{collection ? '书库' : '继续阅读'}</Link><output id="fixture-location-state">{JSON.stringify(location.state)}</output></main>; }
// A rejected lazy module stays rejected across rerenders. Retrying it must
// perform a full document reload, just like a failed deployed reader chunk.
const FailedReaderModule = React.lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/reader-fixture.js')));
function FaultableReader({ manga = false }) {
  const [, redraw] = React.useReducer(value => value + 1, 0);
  fixture.crash = (kind = 'render') => { fixture.failure = kind; redraw(); };
  if (fixture.failure === 'lazy-asset') return <React.Suspense fallback={<ReaderStartupState bookId="resume-test" status="loading" />}><FailedReaderModule /></React.Suspense>;
  if (fixture.failure === 'asset') throw new TypeError('Failed to fetch dynamically imported module: /assets/reader-fixture.js');
  if (fixture.failure) throw new Error('Reader fixture render failure');
  return manga ? <MangaReaderPage /> : <NovelReaderPage />;
}
createRoot(document.getElementById('root'), { onCaughtError(error) { if (!isFixtureError(error)) nativeConsoleError(error); else fixture.caughtErrors.push(error.message); } }).render(<FixtureSession><BrowserRouter><RouteScrollRestoration /><Probe /><Routes><Route path="/reader/novel/:bookId" element={<ReaderErrorBoundary><FaultableReader /></ReaderErrorBoundary>} /><Route path="/reader/manga/:bookId" element={<ReaderErrorBoundary><FaultableReader manga /></ReaderErrorBoundary>} />{query.has('detail') ? <Route element={<ThemeProvider><AppLayout /></ThemeProvider>}><Route path="/books/:bookId" element={<BookDetailPage />} /></Route> : <Route path="/books/:bookId" element={<Destination />} />}<Route path="/library" element={<Destination collection />} /><Route path="/public" element={<Destination collection />} /></Routes></BrowserRouter></FixtureSession>);
