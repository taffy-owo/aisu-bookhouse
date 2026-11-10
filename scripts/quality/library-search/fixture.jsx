import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppLayout } from '../../../src/app/AppLayout';
import { SessionContext } from '../../../src/app/SessionContext';
import { RouteScrollRestoration } from '../../../src/app/RouteScrollRestoration';
import { ThemeProvider } from '../../../src/shared/theme';
import { setStoredSession } from '../../../src/shared/api';
import { LibraryPage } from '../../../src/modules/library/pages/LibraryPage';
import { PublicLibraryPage } from '../../../src/modules/library/pages/PublicLibraryPage';
import { HomePage } from '../../../src/modules/library/pages/HomePage';
import { JapaneseReadingPage } from '../../../src/modules/japanese/pages/JapaneseReadingPage';
import '../../../src/index.css';

const query = new URLSearchParams(location.search);
// Each browser case starts independently; CDP's origin clear does not remove
// sessionStorage navigation snapshots from the tab's previous fixture run.
sessionStorage.clear();
if (query.has('manualPaging')) window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
history.replaceState(null, '', (query.get('page') || '/library') + '?kind=novel&sort=title' + (query.has('grid') ? '' : '&view=list'));
const session = { id: 'search-test-user', nickname: query.has('headerControls') ? '图书馆里一封很长很长的来信' : '搜索测试', email: 'reader.with.a.long.name@example.local', role: query.has('headerControls') ? 'admin' : 'user', status: 'active' };
setStoredSession(session);
localStorage.setItem('aisu-theme', query.get('theme') || 'dark');
const fixture = { held: new Set(), pending: [], requests: [], locations: [], empty: false, failPage: 0, total: 90, overviewDelay: 250, homeCount: 12, overviewReads: 0, notificationReads: 0, notificationCount: query.has('headerControls') ? 6 : 0, notificationError: false };
const homeBooks = Array.from({ length: 12 }, (_, i) => ({
  id: 'home-' + i, title: '第' + (i + 1) + '封来信 · 藏在雨后的图书馆', author: '测试作者', kind: 'novel', reader_type: 'epub', language: 'zh', status: 'ready',
  progress_percent: i === 11 ? 100 : 10 + i * 7, current_chapter: '第十二话 · 长长的来信', chapter_count: 96, character_count: 100000, tags: ['日常'],
  description: '窗外的雨渐渐停了。她在图书馆里打开那封迟来的信。', created_at: '2026-10-01', updated_at: '2026-10-23', is_owned: true,
}));
const bulkBooks = query.has('bulkActions') ? Array.from({ length: 4 }, (_, i) => ({
  id: 'bulk-' + i, title: i === 1 ? 'unbroken_title_'.repeat(20) + ' 第2卷' : '来信系列 第' + (i + 1) + '卷 · 第' + (i + 1) + '封信', author: '测试作者', kind: 'novel', reader_type: 'epub', language: 'zh', status: 'ready', progress_percent: 0, chapter_count: 3, character_count: 10000, tags: [], description: '', created_at: '2026-10-01', updated_at: '2026-10-23', is_owned: true, public_status: 'private', public_download_allowed: false, series_title: '原系列', series_order: i + 1, series_kind: '小说',
})) : [];
Object.assign(fixture, { bulkBooks, mutations: [], mutationStatus: {}, holdMutations: false, pendingMutations: [], mutationMessage: '模拟保存失败，输入已保留。' });
window.searchFixture = fixture;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href), p = url.pathname;
  if (!p.startsWith('/api/v1/')) return nativeFetch(input, options);
  if (query.has('bulkActions') && /^\/api\/v1\/books\/bulk-\d+(?:\/share-request|\/favorite|\/disliked|\/reading-status)?$/.test(p) && options?.method && options.method !== 'GET') {
    const id = p.split('/')[4], book = fixture.bulkBooks.find(book => book.id === id);
    const operation = options.method === 'PATCH' ? 'series' : p.endsWith('/share-request') ? options.method === 'DELETE' ? 'unshare' : 'share' : p.endsWith('/favorite') ? 'favorite' : options.method === 'DELETE' ? 'delete' : 'other';
    const request = { id, operation, method: options.method, body: options.body ? JSON.parse(String(options.body)) : null, signal: options.signal };
    fixture.mutations.push(request);
    if (fixture.holdMutations) await new Promise(resolve => fixture.pendingMutations.push({ ...request, resolve }));
    const status = fixture.mutationStatus[id] || 0;
    if (status) return Response.json({ detail: fixture.mutationMessage }, { status });
    if (operation === 'delete') { fixture.bulkBooks = fixture.bulkBooks.filter(book => book.id !== id); return new Response(null, { status: 204 }); }
    if (operation === 'series') Object.assign(book, request.body);
    if (operation === 'share') Object.assign(book, { public_status: 'pending', public_download_allowed: request.body.public_download_allowed });
    if (operation === 'unshare') book.public_status = 'private';
    if (operation === 'favorite') book.favorite = request.body.favorite;
    return Response.json(book);
  }
  if (p === '/api/v1/books/overview') {
    fixture.overviewReads++;
    await new Promise(resolve => setTimeout(resolve, fixture.overviewDelay));
    return Response.json({ items: homeBooks.slice(0,fixture.homeCount), updated_items: [], total: fixture.homeCount, favorite_count: 0, finished_count: 1, in_progress_count: 11, ongoing_count: 0, source_update_count: 0, book_labels: [], continue_book: homeBooks[0] });
  }
  if (p.match(/^\/api\/v1\/books\/home-\d+\/reader$/)) return Response.json({ reader_type: 'epub', chapter_count: 96, toc: [{ index: 1, title: '来信', position_key: 'key-1' }], pages: [] });
  if (p === '/api/v1/books' || p === '/api/v1/books/public') {
    const q = url.searchParams.get('q') || '', page = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('page_size') || 24);
    const request = { q, page, language: url.searchParams.get('language'), shelf: url.searchParams.get('shelf'), public: p.endsWith('/public'), aborted: false };
    fixture.requests.push(request);
    options?.signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
    if (fixture.held.has(q) || fixture.held.has('page:' + page)) await new Promise(resolve => fixture.pending.push(resolve));
    if (fixture.failPage === page) return Response.json({ detail: '模拟图书列表暂时无法连接。' }, { status: 503 });
    if (query.has('bulkActions')) return Response.json({ items: fixture.bulkBooks, total: fixture.bulkBooks.length, page: 1, page_size: pageSize, has_more: false });
    const total = fixture.empty ? 0 : fixture.total;
    return Response.json({ items: Array.from({ length: Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize)) }, (_, i) => ({
      id: 'search-' + ((page - 1) * pageSize + i), title: (q || '全部') + ' · 第' + ((page - 1) * pageSize + i + 1) + '本来信', author: '测试作者',
      kind: url.searchParams.get('kind') || 'novel', reader_type: 'epub', language: query.has('japaneseShelf') ? 'ja' : 'zh', status: 'ready', progress_percent: 0, chapter_count: 96, character_count: 100000,
      tags: [], description: '窗外的雨渐渐停了。她在图书馆里打开那封迟来的信。', created_at: '2026-10-01', updated_at: '2026-10-23', is_owned: !p.endsWith('/public'),
      owner_nickname: '测试作者', public_status: 'public', public_download_allowed: true, comment_count: 2,
      ...(query.has('series') ? { series_title: '来信系列 ' + (Math.floor(((page - 1) * pageSize + i) / 6) + 1), series_order: i % 6 + 1, series_kind: 'novel' } : {}),
    })), total, page, page_size: pageSize, has_more: page * pageSize < total });
  }
  if (p.includes('notifications')) return Response.json({ items: [], active_count: 0, unread_count: 0 });
  if (p === '/api/v1/books/source-updates') {
    fixture.notificationReads++;
    if (fixture.notificationError) return Response.json({ detail: '通知加载失败，请稍后重试。' }, { status: 503 });
    return Response.json({ items: homeBooks.slice(0, fixture.notificationCount).map(book => ({ ...book, source_update_count: 2, source_episode_count: 98 })), book_count: fixture.notificationCount, episode_count: fixture.notificationCount * 2 });
  }
  if (p.endsWith('/reading-activity')) return Response.json({ days: [], book_totals: [] });
  return Response.json([]);
};
function Probe() {
  const current = useLocation();
  fixture.navigate = useNavigate();
  fixture.location = current;
  if (fixture.locations.at(-1)?.key !== current.key) fixture.locations.push(current);
  return null;
}
function MobileShellProbe() {
  const current = useLocation();
  return <section data-mobile-shell-page={current.pathname}><h1 className="text-base font-semibold">页面内容</h1><p className="mt-3 text-sm">页面末尾的操作应保持可见。</p><div style={{height:'110vh'}} /><button data-mobile-shell-final-action style={{minWidth:88,minHeight:44,fontSize:16}} onClick={() => { fixture.endActions=(fixture.endActions||0)+1; }}>页面末尾操作</button></section>;
}
const noop = async () => {};
const value = { session, isLoading: false, logout: noop, updateNickname: noop, updateAvatar: noop, changePassword: noop, login: async () => session, registerWithInvitation: async () => session };
createRoot(document.getElementById('root')).render(<SessionContext.Provider value={value}><ThemeProvider><BrowserRouter><Probe /><RouteScrollRestoration /><Routes><Route path="/mobile-shell-exit" element={<div data-mobile-shell-exit>独立阅读页面</div>} /><Route element={<AppLayout />}><Route path="/" element={<HomePage />} /><Route path="/books/:bookId" element={<div data-home-book-detail>图书详情测试入口</div>} /><Route path="/library" element={<LibraryPage />} /><Route path="/public" element={<PublicLibraryPage />} /><Route path="/japanese" element={query.has('japaneseShelf') ? <JapaneseReadingPage /> : <MobileShellProbe />} /><Route path="/upload" element={<MobileShellProbe />} /><Route path="/me" element={<MobileShellProbe />} /><Route path="/settings" element={<div data-search-settings>{query.has('mobileShell') ? <MobileShellProbe /> : '搜索入口'}</div>} /></Route></Routes></BrowserRouter></ThemeProvider></SessionContext.Provider>);
