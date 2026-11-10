import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AppLayout } from '../../../src/app/AppLayout';
import { SessionProvider } from '../../../src/app/SessionProvider';
import { useSession } from '../../../src/app/SessionContext';
import { setAccessToken, setStoredSession } from '../../../src/shared/api';
import { ThemeProvider } from '../../../src/shared/theme';
import { ProfilePage } from '../../../src/modules/profile/pages/ProfilePage';
import { HomePage } from '../../../src/modules/library/pages/HomePage';
import '../../../src/index.css';

// Real profile, session provider and HTTP services; all API traffic stays here.
const query = new URLSearchParams(location.search);
let analyticsDays = {}, changeAnalyticsDate;
if (query.has('analytics')) {
  const OriginalDate = Date;
  let fixedNow = query.has('analyticsDate') ? new OriginalDate(query.get('analyticsDate')).getTime() : new OriginalDate(2026, 10, 16, 12).getTime();
  changeAnalyticsDate = value => { fixedNow = new OriginalDate(value).getTime(); };
  window.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  const datasets = {
    short: { '2026-11-14': 59, '2026-11-15': 25, '2026-11-16': 1 },
    ties: { '2026-11-15': 60, '2026-11-16': 89 },
    thresholds: { '2026-11-11': 899, '2026-11-12': 900, '2026-11-13': 1799, '2026-11-14': 1800 },
    long: { '2026-11-14': 10861, '2026-11-15': 86340, '2026-11-16': 1 },
    empty: {},
    calendar: { '2026-11-09': 3600, '2026-11-10': 1800, '2026-11-11': 900, '2026-11-12': 7200, '2026-11-15': 10800, '2026-11-16': 1800, '2026-11-17': 900, '2026-11-18': 450 },
    rollover: { '2026-11-15': 7200 },
    year: { '2025-12-28': 600, '2025-12-29': 120, '2026-01-01': 180, '2026-01-04': 60 },
  };
  const days = datasets[query.get('analytics')];
  if (!days) throw Error('Unknown analytics dataset');
  analyticsDays = days;
  if (!query.has('analyticsCloud')) localStorage.setItem('aisu-bookhouse:reading-activity:account-a', JSON.stringify(days));
}
localStorage.setItem('aisu-theme', query.has('dark') ? 'dark' : 'light');
const user = id => ({ id, account_number: id === 'account-a' ? 1 : 2, nickname: id === 'account-a' ? '阅读者' : '另一个账号', email: id + '@example.local', role: 'user', status: 'active' });
let currentUser = user('account-a');
setStoredSession(currentUser);
setAccessToken('local-fixture-only');
const fixture = {
  requests: [], pending: [], hold: true, fail: false, ignoreAbort: false,
  error: '连接暂时中断，请稍后重试。',
  quotas: Object.fromEntries(['account-a', 'account-b'].map(id => [id, { can_create: query.has('invitations'), remaining: 1, invitation: null }])),
  quotaReads: 0, holdQuota: false, failQuota: false, pendingQuota: [],
  copies: [], holdCopy: true, failCopy: false, pendingCopies: [], acceptThenFail: false,
  setDate(value) { changeAnalyticsDate(value); window.dispatchEvent(new Event('focus')); },
  release() { this.hold = false; this.pending.splice(0).forEach(resolve => resolve()); },
  releaseQuota() { this.holdQuota = false; this.pendingQuota.splice(0).forEach(resolve => resolve()); },
  releaseCopy() { this.holdCopy = false; this.pendingCopies.splice(0).forEach(resolve => resolve()); },
  switchAccount() {
    currentUser = user(currentUser.id === 'account-a' ? 'account-b' : 'account-a');
    setStoredSession(currentUser); setAccessToken('local-fixture-' + currentUser.id);
    window.dispatchEvent(new StorageEvent('storage', { key: 'aisu-bookhouse:session' }));
  },
};
window.accountFixture = fixture;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(code) {
  fixture.copies.push(code);
  const fail = fixture.failCopy;
  if (fixture.holdCopy) await new Promise(resolve => fixture.pendingCopies.push(resolve));
  if (fail) throw Error('Fixture clipboard unavailable');
} } });
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const p = url.pathname.replace(/^\/api\/v1/, ''), method = options.method || 'GET';
  if (!url.pathname.startsWith('/api/')) throw Error('Unexpected fixture request ' + url.pathname);
  if (p === '/auth/me' && method === 'GET') return Response.json(currentUser);
  if ((p === '/auth/me' && method === 'PUT') || p === '/auth/change-password') {
    const request = { operation: p === '/auth/me' ? 'nickname' : 'password', account: currentUser.id, aborted: false };
    const result = p === '/auth/me' ? { ...currentUser, nickname: JSON.parse(options.body).nickname } : null;
    const fail = fixture.fail, error = fixture.error, ignoreAbort = fixture.ignoreAbort;
    fixture.requests.push(request);
    options.signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
    if (fixture.hold) await new Promise((resolve, reject) => {
      fixture.pending.push(resolve);
      if (!ignoreAbort) options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    if (fail) return Response.json({ detail: error }, { status: 422 });
    if (result && !request.aborted) currentUser = result;
    return result ? Response.json(result) : new Response(null, { status: 204 });
  }
  if (p === '/auth/logout') return new Response(null, { status: 204 });
  if (p === '/books/overview') {
    const items = query.has('weekHome') ? [{ id: 'calendar-book', title: '一周的阅读', author: '测试作者', kind: 'novel', reader_type: 'epub', language: 'zh', status: 'ready', progress_percent: 0, chapter_count: 1, tags: [], created_at: '2026-01-01', updated_at: '2026-01-01', is_owned: true }] : [];
    return Response.json({ items, book_labels: [], total: items.length, favorite_count: 0, finished_count: 0, in_progress_count: 0, continue_book: null });
  }
  if (p.startsWith('/books/calendar-book/')) return Response.json({ detail: 'No reader fixture required' }, { status: 404 });
  if (p === '/uploads/tasks') return Response.json([]);
  if (p === '/invitations/me' && method === 'GET') {
    fixture.quotaReads += 1;
    const quota = structuredClone(fixture.quotas[currentUser.id]), fail = fixture.failQuota;
    if (fixture.holdQuota) await new Promise((resolve, reject) => {
      fixture.pendingQuota.push(resolve);
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return fail ? Response.json({ detail: '邀请额度读取暂时失败' }, { status: 422 }) : Response.json(quota);
  }
  if (p === '/invitations/me' && method === 'POST') {
    const request = { operation: 'invitation', account: currentUser.id, aborted: false };
    const quota = fixture.quotas[currentUser.id], fail = fixture.fail, error = fixture.error, ignoreAbort = fixture.ignoreAbort, acceptThenFail = fixture.acceptThenFail;
    fixture.requests.push(request);
    const invitation = { id: 'invite-' + fixture.requests.length, code: 'INVITE' + String(fixture.requests.length).padStart(4, '0'), inviter_user_id: currentUser.id, invitee_user_id: null, status: 'available', created_at: new Date().toISOString(), used_at: null };
    options.signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
    if (fixture.hold) await new Promise((resolve, reject) => {
      fixture.pending.push(resolve);
      if (!ignoreAbort) options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    if (fail) return Response.json({ detail: error }, { status: 422 });
    quota.invitation = invitation;
    if (acceptThenFail) throw new TypeError('生成结果连接中断');
    return Response.json(invitation);
  }
  if (p === '/reading-activity') {
    const days = query.has('analyticsCloud') ? Object.entries(analyticsDays).map(([date_key, seconds]) => ({ date_key, seconds })) : [];
    const total = days.reduce((sum, day) => sum + day.seconds, 0);
    // Deliberately different server calendar metadata: the UI derives local weeks from daily records.
    return Response.json({ days, book_totals: [], today_seconds: total, week_seconds: total, total_seconds: total, streak_days: 0, active_days: days.length, first_read_date: days[0]?.date_key ?? null, last_read_date: days.at(-1)?.date_key ?? null, longest_streak_days: 0 });
  }
  if (p.includes('notifications')) return Response.json({ items: [], unread_count: 0, active_count: 0 });
  throw Error('Unexpected API ' + method + ' ' + p);
};
function Harness() {
  const navigate = useNavigate(), { isLoading, session } = useSession();
  fixture.navigate = navigate;
  fixture.session = session;
  if (isLoading || !session) return <p>读取测试账号…</p>;
  return <Routes><Route element={<AppLayout />}><Route path="/me" element={<ProfilePage />} /><Route path="/" element={<HomePage />} /><Route path="/away" element={<button id="reopen" onClick={() => navigate('/me')}>回到个人中心</button>} /></Route></Routes>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><ThemeProvider><SessionProvider><MemoryRouter initialEntries={['/me']}><Harness /></MemoryRouter></SessionProvider></ThemeProvider></React.StrictMode>);
