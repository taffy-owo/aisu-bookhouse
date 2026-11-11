import { verifyChapterHistory } from './chapter-history-cases.mjs';
import { verifyChapterUpdates } from './chapter-update-cases.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verifyChromePaint } from './chrome-paint-cases.mjs';
import { verifyChapterMutationReload } from './chapter-reload-cases.mjs';
import { verifyChapterDrafts } from './chapter-draft-cases.mjs';
import { verifyEditorInteractions } from './editor-interaction-cases.mjs';
import { verifyReaderPreferences } from './preference-cases.mjs';
import { verifyReaderNavigationUi } from './navigation-ui-cases.mjs';
import { verifyReaderCatalog } from './catalog-cases.mjs';
import { verifyImageControls } from './image-control-cases.mjs';
import { verifyPdfAppearance, verifyPdfControls, verifyPdfMiddleScroll, verifyPdfSelection } from './pdf-control-cases.mjs';
import { verifyBookDialogs } from './book-dialog-cases.mjs';
import { verifyBookActions } from './book-action-cases.mjs';
import { verifyTranslationReview } from './translation-review-cases.mjs';
import { verifyAppendedProgress } from './appended-progress-cases.mjs';
import { verifyChapterProgress } from './chapter-progress-cases.mjs';
import { verifyChapterEditPositions } from './chapter-edit-position-cases.mjs';
import { verifyMarkPositions } from './mark-position-cases.mjs';
import { verifyMarkUpdates } from './mark-update-cases.mjs';

// Run against the actual reader with delayed/failing HTTP responses, isolated
// browser storage and a fake server. No production account or data is used.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const pdfControlsOnly = process.argv.includes('--pdf-controls');
const pdfMiddleScrollOnly = process.argv.includes('--pdf-middle-scroll');
const pdfAppearanceOnly = process.argv.includes('--pdf-appearance');
const pdfSelectionOnly = process.argv.includes('--pdf-selection');
const translationReviewOnly = process.argv.includes('--translation-review');
const appendedProgressOnly = process.argv.includes('--appended-progress');
const chapterProgressOnly = process.argv.includes('--chapter-progress');
const chapterEditPositionsOnly = process.argv.includes('--chapter-edit-positions');
const markPositionsOnly = process.argv.includes('--mark-positions');
const chapterHistoryOnly = process.argv.includes('--chapter-history');
const chapterUpdatesOnly = process.argv.includes('--chapter-updates');
const markUpdatesOnly = process.argv.includes('--mark-updates');
const bookActionsOnly = process.argv.includes('--book-actions');
const bookDialogsOnly = process.argv.includes('--book-dialogs');
const pdfControlsBaseline = process.argv.includes('--pdf-controls-baseline');
const imageControlsOnly = process.argv.includes('--image-controls');
const imageControlsBaseline = process.argv.includes('--image-controls-baseline');
const catalogOnly = process.argv.includes('--catalog');
const catalogBaseline = process.argv.includes('--catalog-baseline');
const navigationUiOnly = process.argv.includes('--navigation-ui');
const navigationUiBaseline = process.argv.includes('--navigation-ui-baseline');
const preferenceLayoutOnly = process.argv.includes('--preference-layout');
const preferencesOnly = process.argv.includes('--preferences') || preferenceLayoutOnly;
const preferenceBaseline = process.argv.includes('--preferences-baseline');
const startupOnly = process.argv.includes('--startup');
const boundaryOnly = process.argv.includes('--boundary');
const mediaOnly = process.argv.includes('--media');
const raceOnly = process.argv.includes('--races');
const marksOnly = process.argv.includes('--marks');
const editorRecoveryOnly = process.argv.includes('--editor-recovery');
const mutationRetryOnly = process.argv.includes('--mutation-retry');
const chapterDraftOnly = process.argv.includes('--chapter-drafts');
const editorInteractionOnly = process.argv.includes('--editor-interactions');
const detailOnly = process.argv.includes('--detail');
const chromeOnly = process.argv.includes('--chrome');
const detailMutationOnly = process.argv.includes('--detail-mutations');
const detailProgressOnly = process.argv.includes('--detail-progress');
const editorOnly = process.argv.includes('--editor') || editorRecoveryOnly || mutationRetryOnly;
const reportDir = path.join(root, 'tmp', 'reader-resume-results');
fs.mkdirSync(reportDir, { recursive: true });
const executable = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(candidate => candidate && fs.existsSync(candidate));
if (!executable) throw Error('Set CHROME_PATH to a Chromium browser executable.');
const vite = await createServer({ root, cacheDir: path.join(reportDir, '.vite', String(process.pid)), optimizeDeps: { entries: ['scripts/quality/reader-resume/fixture.html'] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } }, plugins: [{
  name: 'reader-resume-fixture-routes',
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (/^\/(?:reader\/(?:novel|manga)|books)\/resume-test(?:\?|$)/.test(request.url || '') || /^\/(?:library|public)(?:\?|$)/.test(request.url || '')) request.url = '/scripts/quality/reader-resume/fixture.html';
      next();
    });
  },
}] });
await vite.listen();
const forwardedConsoleErrors = [];
vite.environments.client.hot.on('vite:forward-console', (payload) => {
  if (payload.type === 'log' && payload.data.level === 'error') forwardedConsoleErrors.push(payload.data.message);
});
const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aisu-reader-resume-'));
const child = spawn(executable, ['--headless', '--no-first-run', '--disable-background-networking', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const childExited = new Promise(resolve => child.once('exit', resolve));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tabs;
for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await sleep(100); } }
if (!tabs) { child.kill(); await vite.close(); throw Error('Chrome failed to start'); }
const socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
let id = 0; const calls = new Map(), errors = [], consoleErrors = [], checks = [];
socket.onmessage = ({ data }) => {
  const r = JSON.parse(data);
  if (r.method === 'Runtime.exceptionThrown') errors.push(r.params);
  if (r.method === 'Runtime.consoleAPICalled' && r.params.type === 'error') {
    consoleErrors.push(r.params);
    if (consoleErrors.length === 1) console.log('BROWSER_CONSOLE_ERROR ' + JSON.stringify(r.params));
  }
  const p = calls.get(r.id);
  if (p) { calls.delete(r.id); r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result); }
};
socket.onclose = () => { for (const call of calls.values()) call.reject(Error('Browser debugging connection closed')); calls.clear(); };
function command(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id; calls.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method, params })); }); }
async function evaluate(expression) { const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(expression + JSON.stringify(r.exceptionDetails)); return r.result.value; }
async function wait(expression) { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(80); } throw Error('Timeout ' + expression + ' ' + await evaluate('document.body.innerText.slice(0,700)')); }
function ensure(ok, label, details) { if (!ok) throw Error(label + ' ' + JSON.stringify(details)); checks.push(label); console.log('PASS ' + label); }
const scroller = '(document.querySelector(".reader-document-scroll")?document.scrollingElement:document.querySelector(".reader-viewport"))';
async function state() { return evaluate(`(()=>{const e=${scroller};return {top:e?.scrollTop,title:document.querySelector('.reader-chapter-heading h1')?.textContent,progress:resumeFixture.progress(),pending:resumeFixture.pendingProgress(),history:resumeFixture.chapterHistory()}})()`); }
async function click(expression) { const p = await evaluate(`(()=>{const e=${expression}; if(!e)throw Error('Missing click target'); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p }); await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p }); await sleep(90); }
async function reveal(control = '[aria-label=返回图书详情]') {
  const hidden = `!!document.querySelector(${JSON.stringify(control)})?.closest('[inert]')`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!await evaluate(hidden)) { await sleep(100); if (!await evaluate(hidden)) return; }
    const point = await evaluate('({x:innerWidth/2,y:innerHeight/2})');
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(550);
  }
  await wait(`!(${hidden})`);
}
async function ready(chapter) { await wait(`document.querySelector('.reader-chapter-heading h1')?.textContent===${JSON.stringify('第' + chapter + '话')} && document.querySelector('[data-reader-layout-ready]')?.dataset.readerLayoutReady==='true'`); await sleep(250); }
async function screenshot(name) { const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(reportDir, name + '.png'), Buffer.from(shot.data, 'base64')); }
async function fresh(w, h, touch, query = '', awaitText = true) { await command('Page.navigate', { url: 'about:blank' }); await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }); await command('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch }); await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 }); await command('Page.navigate', { url: origin + '/scripts/quality/reader-resume/fixture.html?' + query }); if (awaitText) await ready(1); }
async function readAt(top, delay = 700) { await evaluate(`${scroller}.scrollTop=${top}`); await sleep(delay); return state(); }
const errorButton = text => `Array.from(document.querySelectorAll('.reader-chapter-error button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
async function back() { if (await evaluate('!!document.querySelector(".reader-chapter-error")')) await click(errorButton('返回图书详情')); else { await reveal(); await click('document.querySelector("[aria-label=返回图书详情]")'); } await wait('!!document.querySelector("#reopen")'); }
async function reopen(chapter = 1) { await click('document.querySelector("#reopen")'); await ready(chapter); }
async function select(index) { await reveal(); await click('document.querySelector("[aria-label=打开目录]")'); await wait('!!document.querySelector(".reader-toc-panel")'); await click(`Array.from(document.querySelectorAll('.reader-toc-item')).find(e=>e.querySelector('span')?.textContent.trim()==='${index}')`); if (await evaluate('!!document.querySelector("[aria-label=关闭目录]")')) await click('document.querySelector("[aria-label=关闭目录]")'); }
try {
  await command('Page.enable'); await command('Runtime.enable'); await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: 'if(location.pathname.endsWith("/fixture.html"))sessionStorage.clear();' });
  if (chapterHistoryOnly) {
    await verifyChapterHistory({ command, ensure, evaluate, fresh, wait, sleep, screenshot });
  } else if (chapterUpdatesOnly) {
    await verifyChapterUpdates({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot });
  } else if (markUpdatesOnly) {
    await verifyMarkUpdates({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot });
  } else if (markPositionsOnly) {
    await verifyMarkPositions({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot });
  } else if (chapterEditPositionsOnly) {
    await verifyChapterEditPositions({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot });
  } else if (chapterProgressOnly) {
    await verifyChapterProgress({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot });
  } else if (appendedProgressOnly) {
    await verifyAppendedProgress({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot });
  } else if (translationReviewOnly) {
    await verifyTranslationReview({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot, baseline: process.argv.includes('--baseline'), reportDir });
  } else if (bookActionsOnly) {
    await verifyBookActions({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot, baseline: process.argv.includes('--baseline'), reportDir });
  } else if (bookDialogsOnly) {
    await verifyBookDialogs({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot, baseline: process.argv.includes('--baseline'), reportDir });
  } else if (pdfSelectionOnly) {
    await verifyPdfSelection({ command, ensure, evaluate, fresh, wait, click, sleep });
  } else if (pdfAppearanceOnly) {
    await verifyPdfAppearance({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot });
  } else if (pdfMiddleScrollOnly) {
    await verifyPdfMiddleScroll({ command, ensure, evaluate, fresh, wait, click, sleep });
  } else if (pdfControlsOnly) {
    await verifyPdfControls({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot, baseline: pdfControlsBaseline, reportDir });
  } else if (imageControlsOnly) {
    await verifyImageControls({ command, ensure, evaluate, fresh, wait, click, reveal, sleep, screenshot, baseline: imageControlsBaseline, reportDir });
  } else if (catalogOnly) {
    await verifyReaderCatalog({ command, ensure, evaluate, fresh, wait, click, reveal, readAt, sleep, screenshot, baseline: catalogBaseline, reportDir });
  } else if (navigationUiOnly) {
    await verifyReaderNavigationUi({ command, ensure, evaluate, fresh, wait, click, reveal, readAt, sleep, screenshot, baseline: navigationUiBaseline, reportDir });
  } else if (preferencesOnly) {
    await verifyReaderPreferences({ command, ensure, evaluate, fresh, ready, wait, click, reveal, readAt, back, reopen, sleep, screenshot, baseline: preferenceBaseline, reportDir, layoutOnly: preferenceLayoutOnly });
  } else if (editorInteractionOnly) {
    await verifyEditorInteractions({ command, ensure, evaluate, fresh, ready, wait, click, reveal, select, sleep, screenshot });
  } else if (chapterDraftOnly) {
    await verifyChapterDrafts({ command, ensure, evaluate, fresh, ready, wait, click, reveal, select, sleep, screenshot });
  } else {
  if (!detailOnly && !chromeOnly && !detailMutationOnly && !detailProgressOnly && !mutationRetryOnly) {
  for (const [w, h, touch] of [[390, 844, true], [768, 1024, true], [1536, 864, false]]) for (const paged of [false, true]) {
    if (startupOnly || boundaryOnly || mediaOnly || raceOnly || marksOnly || editorOnly) continue;
    if (process.env.READER_TEST_WIDTH && w !== Number(process.env.READER_TEST_WIDTH)) continue;
    if (process.env.READER_TEST_MODE && (paged ? 'paged' : 'scroll') !== process.env.READER_TEST_MODE) continue;
    const label = `${w} ${paged ? 'paged' : 'scroll'}`, query = paged ? 'paged&' : '';
    await fresh(w, h, touch, query); const before = await readAt(1830, 6200);
    ensure(before.progress.epub_cfi !== 'aisu-scroll:0' && Object.keys(before.pending).length === 0, label + ' ordinary autosave acknowledges the reading position before exit', before);
    await back(); await reopen(); const after = await state();
    ensure(Math.abs(after.top - before.top) <= 2, label + ' return and reopen preserves visible text', { before, after });
    await evaluate('resumeFixture.flush()');
    await evaluate('history.back()'); await wait('!!document.querySelector("#reopen")'); await reopen(); const popped = await state();
    ensure(Math.abs(popped.top - before.top) <= 2, label + ' browser back and reopen preserves acknowledged progress', { before, popped });
    await command('Page.reload'); await ready(1); const confirmed = await state();
    ensure(Math.abs(confirmed.top - before.top) <= 2, label + ' full reload restores saved server position', { before, confirmed });
    await fresh(w, h, touch, query + 'holdWrites'); const unsent = await readAt(2140, 10); await back(); await reopen(); const recovered = await state();
    ensure(Math.abs(recovered.top - unsent.top) <= 2, label + ' rapid reopen uses pending local position', { unsent, recovered });
    await command('Page.navigate', { url: origin + '/scripts/quality/reader-resume/fixture.html?' + query + 'holdWrites' }); await ready(1); const reloaded = await state();
    ensure(Math.abs(reloaded.top - unsent.top) <= 2, label + ' reload retains unsent position', { unsent, reloaded });
    await fresh(w, h, touch, query + 'failChapter'); const saved = await readAt(1730); await select(2); await wait('document.body.innerText.includes("模拟目标正文加载失败")'); await evaluate('resumeFixture.flush()'); let failed = await state();
    ensure(failed.progress.chapter_index === 1 && Number(failed.progress.epub_cfi.split(':')[1]) > 0, label + ' failed target does not replace current server position', failed);
    ensure(!failed.history['resume-test']?.['chapter:key-2'], label + ' failed target does not create local position', failed);
    ensure(await evaluate('!!document.querySelector(".reader-chapter-error[role=alert]") && document.querySelector(".reader-chrome-top").getAttribute("aria-hidden")==="false"'), label + ' failed chapter announces the error and keeps exit controls visible');
    ensure(await evaluate('getComputedStyle(document.querySelector(".reader-chapter-error")).color === getComputedStyle(document.querySelector(".reader-viewport")).color'), label + ' recovery text follows reader theme');
    ensure(await evaluate('document.querySelector(".reader-reading-status-percent").textContent===String(resumeFixture.progress().progress_percent)+"%"'), label + ' failed target displays confirmed source progress');
    await back(); await reopen(); const resumed = await state();
    ensure(Math.abs(resumed.top - saved.top) <= 2, label + ' failed target then return reopens source text', { saved, resumed });
    await fresh(w, h, touch, query + 'holdChapter'); await readAt(1920); await select(2); await wait('document.body.innerText.includes("正在打开正文")'); await back(); await reopen(); const canceled = await state();
    ensure(Math.abs(canceled.top - 1920) <= 2 && canceled.title === '第1话', label + ' leaving during target load retains source chapter', canceled);
    await fresh(w, h, touch, query); await readAt(1450); await select(2); await ready(2); await sleep(100); await evaluate('resumeFixture.flush()'); let target = await state();
    ensure(target.progress.chapter_index === 2 && target.top < 2, label + ' successful selection commits visible destination', target);
    await readAt(2400); await back(); await reopen(2); target = await state();
    ensure(Math.abs(target.top - 2400) <= 2, label + ' newly selected chapter resumes its own position', target);
    await evaluate('resumeFixture.flush()'); await command('Page.reload'); await ready(2); const targetReloaded = await state();
    ensure(Math.abs(targetReloaded.top - 2400) <= 2, label + ' selected chapter URL reload resumes within the chapter', targetReloaded);
    await select(1); await ready(1); const source = await state();
    ensure(Math.abs(source.top - 1450) <= 2, label + ' catalogue restores previous chapter anchor', source);
    await fresh(w, h, touch, query + 'failChapter=3'); await readAt(1760); await select(3); await wait('!!document.querySelector(".reader-chapter-error")');
    await click(errorButton('返回上次阅读')); await ready(1); const restored = await state();
    ensure(Math.abs(restored.top - 1760) <= 2, label + ' recovery from a nonadjacent failed chapter returns to the actual saved text', restored);
    await select(3); await wait('!!document.querySelector(".reader-chapter-error")'); await evaluate('resumeFixture.failChapter=0'); await click(errorButton('重试本章')); await ready(3); await evaluate('resumeFixture.flush()'); const retried = await state();
    ensure(retried.progress.chapter_index === 3 && retried.top < 2, label + ' successful retry commits destination only after displaying text', retried);
  }
  if (!startupOnly && !boundaryOnly && !mediaOnly && !raceOnly && !marksOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE) {
    for (const theme of ['white', 'paper', 'green', 'dark']) {
      await fresh(320, 568, true, 'failChapter&theme=' + theme); await readAt(980); await select(2); await wait('!!document.querySelector(".reader-chapter-error")');
      ensure(await evaluate('getComputedStyle(document.querySelector(".reader-chapter-error")).color === getComputedStyle(document.querySelector(".reader-viewport")).color'), theme + ' error surface uses reading-theme text');
      ensure(await evaluate('Array.from(document.querySelectorAll(".reader-chapter-error button")).every(e=>{const r=e.getBoundingClientRect();return r.height>=44 && r.x>=0 && r.right<=innerWidth && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})'), theme + ' recovery actions remain visible and tappable on narrow phones');
      await screenshot('recovery-' + theme);
    }
    await fresh(320, 280, true, 'paged&failChapter'); await readAt(700);
    await evaluate('resumeFixture.errorMessage="网络连接暂时中断。".repeat(80)+"x".repeat(320)'); await select(2); await wait('!!document.querySelector(".reader-chapter-error")');
    ensure(await evaluate('getComputedStyle(document.querySelector(".reader-viewport")).overflowY==="auto" && document.querySelector(".reader-viewport").scrollWidth<=innerWidth'), 'long failures remain scrollable without horizontal overflow in paged landscape view');
    await evaluate(scroller + '.scrollTop=' + scroller + '.scrollHeight'); await sleep(100); await click(errorButton('返回图书详情')); await wait('!!document.querySelector("#reopen")'); await reopen();
    ensure(Math.abs((await state()).top - 700) <= 2, 'returning from a long error retains the original reading position');
  }
  if (raceOnly || (!startupOnly && !boundaryOnly && !mediaOnly && !marksOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    for (const [width, height, touch] of [[390, 844, true], [768, 1024, true], [1536, 864, false]]) for (const paged of [false, true]) for (const entry of ['novel', 'manga']) {
      const label = `${width} ${paged ? 'paged' : 'scroll'} via ${entry}`;
      await fresh(width, height, touch, (paged ? 'paged&' : '') + 'holdWrites');
      await readAt(1450, 10); await select(2); await ready(2); const saved = await readAt(2140, 10);
      await back(); await evaluate('resumeFixture.holdStartup=true'); await evaluate(`fixtureNavigate('/reader/${entry}/resume-test')`);
      await wait('resumeFixture.pendingStartups.length>0');
      await evaluate('resumeFixture.holdWrites=false;resumeFixture.pendingWrites.splice(0).forEach(resolve=>resolve());resumeFixture.flush()');
      ensure(await evaluate('resumeFixture.progress().chapter_index===2 && Object.keys(resumeFixture.pendingProgress()).length===0'), label + ' chapter save finishes while startup still holds an earlier chapter');
      await evaluate('resumeFixture.holdStartup=false;resumeFixture.pendingStartups.splice(0).forEach(resolve=>resolve())'); await ready(2);
      const resumed = await state();
      ensure(Math.abs(resumed.top - saved.top) <= 2 && resumed.title === '第2话', label + ' stale startup preserves both the latest chapter and visible text', { saved, resumed });
      await evaluate('resumeFixture.flush()');
      const previousDocument = await evaluate('performance.timeOrigin');
      await command('Page.reload');
      await wait(`performance.timeOrigin!==${previousDocument}`);
      await ready(2); const reloaded = await state();
      ensure(Math.abs(reloaded.top - saved.top) <= 2, label + ' reload after the concurrent save preserves the same text', { saved, reloaded });
    }
  }
  if (mediaOnly || (!startupOnly && !boundaryOnly && !raceOnly && !marksOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    const mediaReady = page => wait(`document.querySelector('.reader-mobile-pan img')?.alt.endsWith('第 ${page} 页') && document.querySelector('.reader-mobile-pan img')?.naturalWidth>0`);
    for (const format of ['readableManga', 'readableImage']) {
      for (const entry of ['manga', 'novel']) {
        const label = `${format} via ${entry}`;
        await fresh(390, 844, true, format + '&holdWrites', false); await mediaReady(1);
        await click('document.querySelector("[aria-label=下一页]")'); await mediaReady(2);
        await wait('resumeFixture.pendingProgress()["resume-test"]?.imageIndex===2');
        await back(); await evaluate('resumeFixture.holdStartup=true'); await evaluate(`fixtureNavigate('/reader/${entry}/resume-test')`);
        await wait('resumeFixture.pendingStartups.length>0');
        await evaluate('resumeFixture.holdWrites=false;resumeFixture.pendingWrites.splice(0).forEach(resolve=>resolve());resumeFixture.flush()');
        ensure(await evaluate('resumeFixture.progress().image_index===2 && Object.keys(resumeFixture.pendingProgress()).length===0'), label + ' newer page save is acknowledged while the old startup snapshot is delayed');
        await evaluate('resumeFixture.holdStartup=false;resumeFixture.pendingStartups.splice(0).forEach(resolve=>resolve())');
        await mediaReady(2);
        ensure(await evaluate('document.querySelector(".reader-mobile-pan img").alt.endsWith("第 2 页")'), label + ' acknowledged local page survives a stale startup response');
        await evaluate('resumeFixture.flush()');
        ensure(await evaluate('resumeFixture.progress().image_index===2 && resumeFixture.attempts.every(p=>p.image_index===2)'), label + ' stale startup cannot overwrite the saved page with page one');
        await back(); await click('document.querySelector("#reopen")'); await mediaReady(2);
        await command('Page.reload'); await mediaReady(2);
        ensure(true, label + ' exit, reopen and full reload preserve the acknowledged page');
      }
      await fresh(390, 844, true, format + '&holdWrites', false); await mediaReady(1);
      await click('document.querySelector("[aria-label=下一页]")'); await mediaReady(2);
      await wait('resumeFixture.pendingProgress()["resume-test"]?.imageIndex===2');
      await back();
      await evaluate('Object.assign(resumeFixture.progress(),{image_index:3,position_key:"image-3",progress_percent:100,updated_at:new Date(Date.now()+1000).toISOString()})');
      await click('document.querySelector("#reopen")'); await mediaReady(3);
      ensure(true, format + ' a newer server position wins over the captured local position');
      await fresh(390, 844, true, format + '&holdWrites', false); await mediaReady(1);
      await click('document.querySelector("[aria-label=下一页]")'); await mediaReady(2);
      await wait('resumeFixture.pendingProgress()["resume-test"]?.imageIndex===2');
      await back(); await evaluate('resumeFixture.holdStartup=true'); await click('document.querySelector("#reopen")');
      await wait('resumeFixture.pendingStartups.length>0');
      await evaluate('resumeFixture.holdWrites=false;resumeFixture.pendingWrites.splice(0).forEach(resolve=>resolve());resumeFixture.flush()');
      await evaluate('resumeFixture.holdStartup=false;resumeFixture.startupStatus=503;resumeFixture.pendingStartups.splice(0).forEach(resolve=>resolve())');
      await wait('!!document.querySelector(".reader-startup-state[role=alert]")');
      await evaluate('resumeFixture.startupStatus=0'); await click('document.querySelector(".reader-startup-state button")'); await mediaReady(2);
      ensure(true, format + ' startup retry after the acknowledged save resumes the correct page');
    }
  }
  if (startupOnly || (!boundaryOnly && !mediaOnly && !raceOnly && !marksOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    const returnLink = 'document.querySelector(".reader-state-return")';
    const startupButton = 'document.querySelector(".reader-startup-state button")';
    const downloadButton = 'document.querySelector(".reader-unsupported-state button")';
    for (const manga of [false, true]) {
      const kind = manga ? 'manga' : 'novel', options = manga ? 'manga&' : '';
      await fresh(390, 844, true, options + 'direct&holdStartup&collection=public', false);
      await wait('document.querySelector(".reader-startup-state")?.getAttribute("aria-busy")==="true" && resumeFixture.pendingStartups.length>0');
      ensure(await evaluate(returnLink + '?.getAttribute("href")==="/books/resume-test"'), kind + ' pending direct startup has a deterministic book-detail exit');
      await click(returnLink); await wait('!!document.querySelector("#reopen")');
      ensure(await evaluate('resumeFixture.startupRequests.every(r=>r.signal?.aborted) && JSON.parse(document.querySelector("#fixture-location-state").textContent).collectionReturn.pathname==="/public"'), kind + ' leaving startup aborts the request and preserves the source collection');
      await evaluate('resumeFixture.holdStartup=false;resumeFixture.pendingStartups.splice(0).forEach(resolve=>resolve())'); await sleep(200);
      ensure(await evaluate('!!document.querySelector("#reopen") && !document.querySelector(".reader-viewport") && resumeFixture.attempts.length===0'), kind + ' late startup success cannot reopen the reader or save imagined progress');
      for (const collection of ['', 'public']) {
        await fresh(390, 844, true, options + 'direct&startupError=404' + (collection ? '&collection=' + collection : ''), false);
        await wait('document.querySelector("#reader-startup-title")?.textContent==="找不到这本书"');
        ensure(await evaluate('!document.body.textContent.includes("暂时无法连接") && document.querySelector(".reader-startup-state").getAttribute("role")==="alert"'), kind + ' 404 is announced as a missing book ' + (collection || 'default shelf'));
        await click(returnLink); await wait('!!document.querySelector("#collection-return")');
        ensure(await evaluate(collection ? 'location.pathname==="/public" && location.search==="?q=test&sort=recent" && JSON.parse(document.querySelector("#fixture-location-state").textContent).restoreNavigationKey==="source-collection"' : 'location.pathname==="/library"'), kind + ' missing book returns to a usable collection ' + (collection || 'default shelf'));
      }
      await fresh(768, 600, true, options + 'direct&startupError=503&collection=library', false);
      await wait('document.querySelector("#reader-startup-title")?.textContent==="阅读器暂时无法连接"');
      ensure(await evaluate('document.querySelector(".reader-startup-state").textContent.includes(resumeFixture.startupMessage)'), kind + ' startup failure preserves the actionable server message');
      await screenshot(kind + '-startup-error');
      await evaluate('resumeFixture.startupStatus=0'); await click(startupButton);
      if (manga) await wait('!!document.querySelector(".reader-unsupported-state")'); else await ready(1);
      ensure(await evaluate('!document.querySelector(".reader-startup-state") && resumeFixture.attempts.length===0'), kind + ' retry opens the verified resource without false progress');
      if (manga) await click(returnLink); else await back();
      await wait('!!document.querySelector("#reopen")');
      ensure(await evaluate('JSON.parse(document.querySelector("#fixture-location-state").textContent).collectionReturn.key==="source-collection"'), kind + ' successful recovery retains collection return context');
      await fresh(320, 260, true, options + 'direct&startupError=503&longError&theme=dark', false);
      await wait('document.querySelector("#reader-startup-title")?.textContent==="阅读器暂时无法连接"');
      ensure(await evaluate('document.querySelector("#reader-startup-title").getBoundingClientRect().top>=0 && document.querySelector(".reader-state-surface").scrollWidth<=innerWidth'), kind + ' long startup failure keeps its heading reachable in a short landscape window');
      await evaluate('document.querySelector(".reader-state-surface").scrollTop=document.querySelector(".reader-state-surface").scrollHeight'); await sleep(100);
      await click(returnLink); await wait('!!document.querySelector("#reopen")');
      ensure(true, kind + ' long startup failure keeps its exit reachable by scrolling');
      await fresh(390, 844, true, options + 'direct&startupError=-1', false);
      await wait('document.querySelector("#reader-startup-title")?.textContent==="阅读器暂时无法连接"');
      ensure(await evaluate('document.querySelector(".reader-startup-state").textContent.includes("请检查网络连接后重试") && !document.body.textContent.includes("Failed to fetch")'), kind + ' network exception becomes a readable recovery message');
    }
    for (const theme of ['white', 'paper', 'green', 'dark']) {
      await fresh(320, 568, true, 'direct&unsupported&holdDownload&theme=' + theme, false);
      await wait('!!document.querySelector(".reader-unsupported-state")');
      ensure(await evaluate('document.querySelectorAll(".reader-state-return").length===1 && getComputedStyle(document.querySelector(".reader-unsupported-state")).color===getComputedStyle(document.querySelector(".reader-state-surface")).color && getComputedStyle(document.querySelector(".reader-state-action")).color===getComputedStyle(document.querySelector(".reader-state-surface")).color'), theme + ' unsupported format uses reader theme and a single return action');
      await screenshot('unsupported-' + theme);
      await click(downloadButton); await wait('document.querySelector(".reader-state-action")?.getAttribute("aria-busy")==="true"');
      await evaluate(downloadButton + '.click()');
      ensure(await evaluate('resumeFixture.downloadRequests===1 && document.querySelector(".reader-state-action").disabled'), theme + ' download preparation blocks duplicate submissions');
      await evaluate('resumeFixture.pendingDownloads.splice(0).forEach(resolve=>resolve())'); await wait('!!document.querySelector(".reader-unsupported-state [role=alert]")');
      ensure(await evaluate('!document.querySelector(".reader-state-action").disabled && document.querySelector(".reader-unsupported-state [role=alert]").textContent.includes("下载准备暂时失败")'), theme + ' failed download exposes a retry without losing the exit');
      await click(returnLink); await wait('!!document.querySelector("#reopen")');
    }
    await fresh(320, 260, true, 'direct&unsupported&longError&theme=dark', false);
    await wait('!!document.querySelector(".reader-unsupported-state")'); await click(downloadButton); await wait('!!document.querySelector(".reader-unsupported-state [role=alert]")');
    ensure(await evaluate('document.querySelector("#reader-unsupported-title").getBoundingClientRect().top>=0 && document.querySelector(".reader-state-surface").scrollWidth<=innerWidth'), 'long download errors wrap without hiding the page heading or causing horizontal overflow');
    await evaluate('document.querySelector(".reader-state-surface").scrollTop=0'); await click(returnLink); await wait('!!document.querySelector("#reopen")');
    ensure(true, 'unsupported-format exit stays reachable above a long download error');
    await fresh(1536, 864, false, 'direct&pdf&collection=public', false);
    await wait('!!document.querySelector("[aria-label=返回书籍]")');
    await click('document.querySelector("[aria-label=返回书籍]")'); await wait('!!document.querySelector("#reopen")');
    ensure(await evaluate('location.pathname==="/books/resume-test" && JSON.parse(document.querySelector("#fixture-location-state").textContent).collectionReturn.pathname==="/public"'), 'PDF return opens book detail even with no prior in-site history and retains collection context');
  }
  if (boundaryOnly || (!startupOnly && !mediaOnly && !raceOnly && !marksOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    const retry = 'document.querySelector(".reader-render-error button")';
    const exit = 'document.querySelector(".reader-render-error .reader-state-return")';
    for (const [width, height, touch] of [[390, 844, true], [768, 1024, true], [1536, 864, false]]) {
      for (const paged of [false, true]) {
        const mode = `${width} ${paged ? 'paged' : 'scroll'}`, options = paged ? 'paged&' : '';
        await fresh(width, height, touch, options + 'collection=public');
        const before = await readAt(1960, 10);
        await evaluate('resumeFixture.crash()'); await wait('!!document.querySelector(".reader-render-error")');
        ensure(await evaluate('resumeFixture.caughtErrors.length===1 && resumeFixture.loggedBoundaryErrors.length===1 && !document.body.textContent.includes("Reader fixture render failure")'), mode + ' rendering failure is caught and shows a readable recovery surface');
        await evaluate('resumeFixture.failure=""'); await click(retry); await ready(1); const resumed = await state();
        ensure(Math.abs(resumed.top - before.top) <= 2, mode + ' retry after a render failure retains the latest visible reading position', { before, resumed });
        await evaluate('resumeFixture.crash()'); await wait('!!document.querySelector(".reader-render-error")');
        await click(exit); await wait('!!document.querySelector("#reopen")');
        ensure(await evaluate('location.pathname==="/books/resume-test" && JSON.parse(document.querySelector("#fixture-location-state").textContent).collectionReturn.pathname==="/public"'), mode + ' rendering failure keeps a deterministic exit and collection context');
        await evaluate('resumeFixture.failure=""'); await reopen(); const reopened = await state();
        ensure(Math.abs(reopened.top - before.top) <= 2, mode + ' returning from a render failure and reopening resumes the same text', { before, reopened });
        await evaluate('resumeFixture.crash()'); await wait('!!document.querySelector(".reader-render-error")');
        await click('document.querySelectorAll(".reader-render-error button")[1]'); await ready(1); const refreshed = await state();
        ensure(Math.abs(refreshed.top - before.top) <= 2, mode + ' explicit refresh from a render failure resumes the same text', { before, refreshed });
      }
    }
    for (const theme of ['white', 'paper', 'green', 'dark']) {
      await fresh(320, 280, true, 'direct&crash=render&theme=' + theme, false);
      await wait('!!document.querySelector(".reader-render-error")');
      ensure(await evaluate(`document.querySelector('.reader-state-surface').classList.contains('reader-theme-${theme}') && getComputedStyle(document.querySelector('#reader-error-title')).color===getComputedStyle(document.querySelector('.reader-state-surface')).color && [...document.querySelectorAll('.reader-render-error button')].every(e=>getComputedStyle(e).color===getComputedStyle(document.querySelector('.reader-state-surface')).color)`), theme + ' rendering error and all controls follow the reader theme');
      ensure(await evaluate('document.querySelector("#reader-error-title").getBoundingClientRect().top>=0 && document.querySelector(".reader-state-surface").scrollWidth<=innerWidth && document.querySelector(".reader-render-error").getAttribute("role")==="alert"'), theme + ' small landscape error keeps its heading reachable and announces the failure');
      await screenshot('render-error-' + theme);
      await evaluate('document.querySelector(".reader-state-surface").scrollTop=document.querySelector(".reader-state-surface").scrollHeight'); await sleep(100);
      await click(exit); await wait('!!document.querySelector("#reopen")');
      ensure(true, theme + ' rendering-error exit remains reachable in a short window');
    }
    await fresh(390, 844, true, 'theme=white');
    await evaluate('localStorage.setItem("aisu-bookhouse:reader-preferences", JSON.stringify({...JSON.parse(localStorage.getItem("aisu-bookhouse:reader-preferences")),theme:"green"}));resumeFixture.crash()');
    await wait('!!document.querySelector(".reader-render-error")');
    ensure(await evaluate('document.querySelector(".reader-state-surface").classList.contains("reader-theme-green")'), 'rendering recovery reads the most recent reading theme instead of the route mount theme');
    await evaluate('resumeFixture.failure="";fixtureNavigate("/reader/novel/resume-test?chapter=2")'); await ready(2);
    ensure(await evaluate('!document.querySelector(".reader-render-error")'), 'navigating to another chapter clears the previous render failure');
    await fresh(390, 844, true, 'direct&manga&crash=render&theme=white', false);
    await wait('!!document.querySelector(".reader-render-error")');
    ensure(await evaluate('document.querySelector(".reader-state-surface").classList.contains("reader-theme-dark")'), 'manga rendering recovery consistently uses its dark reading theme');
    await click(exit); await wait('!!document.querySelector("#reopen")');
    await fresh(390, 844, true, 'direct&crash=lazy-asset&offline&collection=public', false);
    await wait('!!document.querySelector(".reader-render-error")');
    ensure(await evaluate('document.querySelector("#reader-error-title").textContent==="阅读器资源未能加载" && document.querySelector(".reader-render-error button").disabled && document.body.textContent.includes("网络连接已断开") && resumeFixture.startupRequests.length===0'), 'offline asset failure prevents futile reloads and retains a usable return link');
    await evaluate('Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>true});window.dispatchEvent(new Event("online"))');
    await wait('!document.querySelector(".reader-render-error button").disabled');
    ensure(await evaluate('!document.body.textContent.includes("网络连接已断开") && document.querySelector(".reader-render-error button").textContent==="重新加载"'), 'network reconnection enables asset recovery and refreshes its message');
    await evaluate('sessionStorage.setItem("resume-options","theme=dark")'); await click(retry); await ready(1);
    ensure(await evaluate('!document.querySelector(".reader-render-error")'), 'explicit asset retry reloads the document and clears the cached import failure');
    await fresh(390, 844, true, 'direct&crash=lazy-asset&assetCooldown', false);
    await wait('!!document.querySelector(".reader-render-error")');
    ensure(await evaluate('document.querySelector(".reader-render-error button").disabled===false && resumeFixture.caughtErrors.length===1 && resumeFixture.loggedBoundaryErrors.length===1'), 'a repeated asset failure stops automatic reload loops and exposes manual recovery');
    await click(exit); await wait('!!document.querySelector("#reopen")');
    ensure(await evaluate('location.pathname==="/books/resume-test" && resumeFixture.attempts.length===0'), 'asset failure exits directly to book detail without saving unread progress');
    await fresh(390, 844, true); const saved = await readAt(2140);
    await evaluate('resumeFixture.flush();sessionStorage.removeItem("aisu.asset-reload-at");resumeFixture.crash("lazy-asset")');
    await ready(1); const automaticallyRestored = await state();
    ensure(Math.abs(automaticallyRestored.top - saved.top) <= 2 && await evaluate('Number(sessionStorage.getItem("aisu.asset-reload-at"))>0'), 'one automatic asset reload recovers the current chapter and saved position', { saved, automaticallyRestored });
  }
  if (marksOnly || (!startupOnly && !boundaryOnly && !mediaOnly && !raceOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    const click = async expression => {
      await evaluate('('+expression+').scrollIntoView({block:"center",behavior:"instant"})');
      await wait('(()=>{const e='+expression+',r=e.getBoundingClientRect();return r.width>0 && r.height>0 && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()');
      const point=await evaluate('(()=>{const r=('+expression+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
      await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
      await sleep(90);
    };
    const note = 'document.querySelector("[aria-label=阅读备注]")';
    const save = 'Array.from(document.querySelectorAll(".reader-mark-save-actions button")).find(e=>e.textContent.includes("存备注"))';
    const openMarks = async () => { if (await evaluate('!!document.querySelector(".reader-marks-panel")')) return; await reveal('[aria-label=打开书签与备注]'); await click('document.querySelector("[aria-label=打开书签与备注]")'); await wait('!!document.querySelector(".reader-marks-panel")'); };
    const closeMarks = async () => { await click('document.querySelector("[aria-label=关闭书签与备注]")'); await wait('!document.querySelector(".reader-marks-panel")'); };
    const typeNote = async text => { await evaluate(note + '.focus();' + note + '.select()'); await command('Input.insertText', { text }); await sleep(80); };
    const contrast = async (selector = '.reader-mark-compose [role=alert]') => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),p=document.querySelector('.reader-marks-panel');const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');const lum=s=>{ctx.fillStyle=s;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)};const color=getComputedStyle(e).color,bg=getComputedStyle(p).backgroundColor,a=lum(color),b=lum(bg);return {ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),color,bg}})()`);
    for (const theme of ['dark', 'white', 'paper', 'green']) {
      await fresh(390, 844, true, 'theme=' + theme); await readAt(1230); await openMarks();
      await typeNote('保存失败也不能丢失的想法'); await evaluate('resumeFixture.markStatus.create=503'); await click(save);
      await wait('document.querySelector(".reader-mark-compose [role=alert]")?.textContent.includes("模拟标记保存失败")');
      ensure(await evaluate(note + '.value==="保存失败也不能丢失的想法" && resumeFixture.marks().length===0'), theme + ' failed note save preserves the draft without inventing a saved mark');
      const lightSite = await contrast();
      ensure(lightSite.ratio >= 4.5, theme + ' note error remains readable with the light site theme', lightSite);
      await evaluate('document.documentElement.classList.add("dark")'); const darkSite = await contrast();
      ensure(darkSite.ratio >= 4.5 && darkSite.color === lightSite.color, theme + ' note error follows the reading palette independently of the site theme', { lightSite, darkSite });
      const draftMeta = await contrast('#reader-note-help');
      ensure(draftMeta.ratio >= 4.5, theme + ' draft source and character count remain legible in the reading palette', draftMeta);
      await screenshot('note-error-' + theme);
      await click('document.querySelector("[aria-label=关闭书签与备注]")'); await openMarks();
      ensure(await evaluate(note + '.value==="保存失败也不能丢失的想法"'), theme + ' closing and reopening a failed save preserves its draft');
      await evaluate('resumeFixture.markStatus.create=0'); await click(save);
      await wait('document.querySelectorAll("[data-reader-mark-id]").length===1 && document.querySelector("[aria-label=阅读备注]").value===""');
      ensure(await evaluate('resumeFixture.marks().length===1 && resumeFixture.marks()[0].note==="保存失败也不能丢失的想法"'), theme + ' retry confirms the original note once and clears only its saved draft');
      const savedMeta = await contrast('.reader-mark-item .reader-mark-meta'), savedNote = await contrast('.reader-mark-note');
      ensure(savedMeta.ratio >= 4.5 && savedNote.ratio >= 4.5, theme + ' saved note text and source coordinates retain readable contrast', { savedMeta, savedNote });
      const point = await evaluate('(()=>{const r=document.querySelector("[aria-label^=删除标记]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await sleep(250);
      ensure(await evaluate('getComputedStyle(document.querySelector("[aria-label^=删除标记]")).color') === lightSite.color, theme + ' delete hover uses the same readable reading-theme warning color');
      await closeMarks();
      ensure(Math.abs((await state()).top - 1230) <= 2, theme + ' closing the notes panel returns to the original visible text');
    }
    for (const [width, height, touch] of [[390, 844, true], [768, 1024, true], [1536, 864, false]]) {
      await fresh(width, height, touch); const position = await readAt(1760); await openMarks();
      await typeNote('第一条笔记'); await evaluate('resumeFixture.holdMarks.create=true'); await click(save);
      await wait('resumeFixture.pendingMarks.some(r=>r.operation==="create")');
      await evaluate('document.querySelectorAll(".reader-mark-save-actions button")[1].click()');
      ensure(await evaluate('resumeFixture.markRequests.filter(r=>r.operation==="create").length===1'), width + ' repeated save clicks create only one pending note');
      await typeNote('保存期间新写的草稿'); await closeMarks(); await openMarks();
      await evaluate('resumeFixture.holdMarks.create=false;resumeFixture.pendingMarks.splice(0).forEach(r=>r.resolve())');
      await wait('document.querySelectorAll("[data-reader-mark-id]").length===1 && !document.querySelectorAll(".reader-mark-save-actions button")[1].disabled');
      ensure(await evaluate(note + '.value==="保存期间新写的草稿" && resumeFixture.marks()[0].note==="第一条笔记"'), width + ' delayed confirmation cannot clear later edits or replace the submitted text');
      await evaluate('resumeFixture.holdMarks.load=true'); await click('document.querySelector("[aria-label=刷新书签与备注]")');
      await wait('resumeFixture.pendingMarks.some(r=>r.operation==="load")'); await click(save);
      await wait('document.querySelectorAll("[data-reader-mark-id]").length===2');
      await evaluate('resumeFixture.holdMarks.load=false;resumeFixture.pendingMarks.splice(0).forEach(r=>r.resolve())');
      await wait('document.querySelector("[aria-label=刷新书签与备注]").getAttribute("aria-busy")==="false"');
      ensure(await evaluate('document.querySelectorAll("[data-reader-mark-id]").length===2 && resumeFixture.marks().length===2'), width + ' a stale list response cannot erase a newly confirmed note');
      await evaluate('resumeFixture.markStatus.remove=503'); await click('document.querySelector("[aria-label^=删除标记]")');
      await wait('document.querySelector(".reader-mark-compose [role=alert]")?.textContent.includes("模拟标记删除失败")');
      ensure(await evaluate('document.querySelectorAll("[data-reader-mark-id]").length===2 && resumeFixture.marks().length===2'), width + ' deletion failure retains the existing note and allows retry');
      await evaluate('resumeFixture.markStatus.remove=0'); await click('document.querySelector("[aria-label^=删除标记]")');
      await wait('document.querySelectorAll("[data-reader-mark-id]").length===1');
      await evaluate('resumeFixture.markStatus.load=503'); await click('document.querySelector("[aria-label=刷新书签与备注]")');
      await wait('document.querySelector(".reader-marks-list-region [role=alert]")?.textContent.includes("模拟标记加载失败")');
      ensure(await evaluate('document.querySelectorAll("[data-reader-mark-id]").length===1 && !document.body.textContent.includes("还没有书签或备注")'), width + ' refresh failure keeps the known list instead of showing an empty library');
      await evaluate('resumeFixture.markStatus.load=0'); await click('Array.from(document.querySelectorAll(".reader-marks-list-region button")).find(e=>e.textContent.includes("重试加载"))');
      await wait('!document.querySelector(".reader-marks-list-region [role=alert]") && document.querySelectorAll("[data-reader-mark-id]").length===1');
      await typeNote('返回或刷新都要留下的草稿'); const origin = await evaluate('document.querySelector("#reader-note-help span").textContent');
      await closeMarks();
      ensure(Math.abs((await state()).top - position.top) <= 2, width + ' note mutations and retries do not move the reading position');
      await back(); await reopen(); await openMarks();
      ensure(await evaluate(note + '.value==="返回或刷新都要留下的草稿" && document.querySelector("#reader-note-help span").textContent===' + JSON.stringify(origin)), width + ' exit and reopen retain the unsaved note and its source coordinates');
      await command('Page.reload'); await ready(1); const restored = await state(); await openMarks();
      ensure(Math.abs(restored.top - position.top) <= 2 && await evaluate(note + '.value==="返回或刷新都要留下的草稿" && document.querySelector("#reader-note-help span").textContent===' + JSON.stringify(origin)), width + ' a full reload retains both the draft and its original reading position', { position, restored });
    }
    await fresh(768, 1024, true); await readAt(1200); await openMarks(); await typeNote('旧定位的内容要保留'); await click(save);
    await wait('document.querySelectorAll("[data-reader-mark-id]").length===1'); await closeMarks(); await select(2); await ready(2); await readAt(1400); await openMarks();
    await evaluate('resumeFixture.marks()[0].position_valid=false'); await click('document.querySelector("[aria-label=刷新书签与备注]")');
    await wait('document.querySelector("[data-reader-mark-jump]")?.disabled');
    const relocate = 'Array.from(document.querySelectorAll(".reader-mark-item button")).find(e=>e.textContent.includes("定位到当前"))';
    await evaluate('resumeFixture.markStatus.relocate=503'); await click(relocate);
    await wait('document.querySelector(".reader-mark-compose [role=alert]")?.textContent.includes("模拟标记定位失败")');
    ensure(await evaluate('resumeFixture.marks()[0].chapter_index===1 && resumeFixture.marks()[0].note==="旧定位的内容要保留" && document.querySelector("[data-reader-mark-jump]").disabled'), 'failed relocation preserves the note content and original coordinates');
    await evaluate('resumeFixture.markStatus.relocate=0'); await click(relocate);
    await wait('document.querySelector("[data-reader-mark-jump]")?.disabled===false && !Array.from(document.querySelectorAll(".reader-mark-item button")).some(e=>e.textContent.includes("定位到当前"))');
    ensure(await evaluate('resumeFixture.marks()[0].chapter_index===2 && resumeFixture.marks()[0].position_key==="key-2" && resumeFixture.marks()[0].note==="旧定位的内容要保留" && document.activeElement.hasAttribute("data-reader-mark-jump")'), 'successful relocation keeps the content, updates its keyed chapter and returns focus to its jump action');
    await click('document.querySelector("[data-reader-mark-jump]")'); await wait('!document.querySelector(".reader-marks-panel")'); await ready(2);
    ensure(Math.abs((await state()).top - 1400) <= 2, 'relocated note returns to the exact captured passage');
    await fresh(390, 844, true); await openMarks(); await typeNote('旧账号已提交的笔记');
    await evaluate('resumeFixture.holdMarks.create=true'); await click(save); await wait('resumeFixture.pendingMarks.some(r=>r.operation==="create")');
    await typeNote('旧账号后续草稿');
    await evaluate('resumeFixture.switchAccount("other-reader")'); await ready(1); await openMarks();
    ensure(await evaluate(note + '.value==="" && document.querySelectorAll("[data-reader-mark-id]").length===0 && resumeFixture.markRequests.find(r=>r.operation==="create").signal.aborted'), 'account switch clears the visible old notes and aborts the old save request');
    await evaluate('resumeFixture.holdMarks.create=false;resumeFixture.pendingMarks.splice(0).forEach(r=>r.resolve())'); await sleep(150);
    ensure(await evaluate(note + '.value==="" && document.querySelectorAll("[data-reader-mark-id]").length===0'), 'late old-account confirmation cannot populate or clear the new account note panel');
    await typeNote('新账号的笔记'); await click(save); await wait('document.querySelectorAll("[data-reader-mark-id]").length===1');
    ensure(await evaluate('resumeFixture.marks().length===1 && resumeFixture.marks()[0].note==="新账号的笔记"'), 'new-account saving remains usable after an old-account request finishes');
    await evaluate('resumeFixture.switchAccount("resume-test-user")'); await ready(1); await openMarks();
    ensure(await evaluate(note + '.value==="旧账号后续草稿" && resumeFixture.marks().length===1 && document.querySelector("[data-reader-mark-id]").textContent.includes("旧账号已提交的笔记")'), 'switching back restores only the original account draft and confirmed note');
    for (const format of ['readableManga', 'readableImage']) {
      await fresh(768, 1024, true, format, false);
      await wait('document.querySelector(".reader-mobile-pan img")?.naturalWidth>0');
      await click('document.querySelector("[aria-label=下一页]")'); await wait('document.querySelector(".reader-mobile-pan img")?.alt.endsWith("第 2 页")');
      await openMarks(); await typeNote('图片第二页的备注'); await click(save); await wait('document.querySelectorAll("[data-reader-mark-id]").length===1');
      ensure(await evaluate('resumeFixture.marks()[0].image_index===2 && resumeFixture.marks()[0].position_key==="image-2" && resumeFixture.marks()[0].note==="图片第二页的备注"'), format + ' saves the note against the visible keyed image page');
      await closeMarks(); await reveal(); await click('document.querySelector("[aria-label=下一页]")'); await wait('document.querySelector(".reader-mobile-pan img")?.alt.endsWith("第 3 页")');
      await openMarks(); await click('document.querySelector("[data-reader-mark-jump]")');
      await wait('!document.querySelector(".reader-marks-panel") && document.querySelector(".reader-mobile-pan img")?.alt.endsWith("第 2 页")');
      ensure(true, format + ' note selection returns directly to its original image page');
    }
    await fresh(320, 280, true); await openMarks(); await typeNote('长备注'.repeat(650));
    await evaluate('resumeFixture.markStatus.create=503;Array.from(document.querySelectorAll(".reader-mark-save-actions button")).find(e=>e.textContent.includes("存备注")).scrollIntoView({block:"nearest"})');
    await click(save); await wait('!!document.querySelector(".reader-mark-compose [role=alert]")');
    ensure(await evaluate('(()=>{const p=document.querySelector(".reader-marks-panel"),s=getComputedStyle(p).overflowY==="auto"?p:p.querySelector(".overflow-y-auto");return p.scrollWidth<=p.clientWidth && s.scrollHeight>s.clientHeight && document.querySelector("[aria-label=阅读备注]").value.length===1950})()'), 'short landscape note errors and long drafts stay scrollable without horizontal overflow');
    await evaluate('document.querySelector(".reader-marks-panel").scrollTop=0'); await sleep(80);
    await click('document.querySelector("[aria-label=关闭书签与备注]")'); await wait('!document.querySelector(".reader-marks-panel")');
    ensure(await evaluate('document.body.style.position!=="fixed"'), 'short landscape note panel retains its reachable exit and releases the scroll lock');
    await fresh(390, 844, true); await openMarks();
    await evaluate('(()=>{const native=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith("aisu:reader-note-draft:"))throw new DOMException("Fixture quota","QuotaExceededError");return native.call(this,key,value)}})()');
    await typeNote('存储空间不足也要保住当前草稿'); await closeMarks(); await openMarks();
    ensure(await evaluate(note + '.value==="存储空间不足也要保住当前草稿"'), 'blocked draft storage still preserves current-tab edits across panel closes');
  }
  if (!editorRecoveryOnly && (editorOnly || (!startupOnly && !boundaryOnly && !mediaOnly && !raceOnly && !marksOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE))) {
    const editor = 'document.querySelector("[aria-labelledby=edit-chapter-title]")';
    const editBody = editor + '.querySelector("textarea")', editTitle = editor + '.querySelector("input")';
    const saveEdit = editor + '.querySelector(".chapter-editor-save")';
    const openEditor = async () => { await reveal('[aria-label=编辑本章]'); await click('document.querySelector("[aria-label=编辑本章]")'); await wait('!!' + editor); await sleep(150); };
    const closeEditor = async () => { await evaluate(editor + '.scrollTop=0'); await click('document.querySelector("[aria-label=关闭章节编辑]")'); await wait('!'+editor); };
    const typeEdit = async (text, field = editBody) => { await evaluate(field + '.focus();' + field + '.select()'); await command('Input.insertText', { text }); await sleep(80); };
    const editorColors = async () => evaluate(`(()=>{const e=${editor},p=document.querySelector('.reader-viewport'),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');const rgb=s=>{ctx.fillStyle=s;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};const lum=s=>rgb(s).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);const contrast=(c,b)=>{const a=lum(c),v=lum(b);return (Math.max(a,v)+.05)/(Math.min(a,v)+.05)};const style=getComputedStyle(e),bg=style.backgroundColor;return {surface:rgb(bg),expected:rgb(getComputedStyle(p).getPropertyValue('--reader-page')),scheme:style.colorScheme,controls:[...e.querySelectorAll('h2,label,input,textarea,.chapter-editor-meta,button,[role=alert]')].filter(n=>n.textContent.trim()||n.matches('input,textarea')).map(n=>{const s=getComputedStyle(n),b=s.backgroundColor==='rgba(0, 0, 0, 0)'?bg:s.backgroundColor;return {kind:n.tagName,disabled:!!n.disabled,color:s.color,background:s.backgroundColor,ratio:contrast(s.color,b)}})}})()`);
    for (const theme of ['dark', 'white', 'paper', 'green']) {
      await fresh(390, 844, true, 'theme=' + theme); await readAt(1230); await openEditor();
      const original = await evaluate(editBody + '.value');
      await typeEdit(original + '\n\n编辑失败后仍要保留的正文。'); await typeEdit('修改后的章节名', editTitle);
      await evaluate('resumeFixture.editorStatus.save=503'); await click(saveEdit);
      await wait(editor + '?.querySelector("[role=alert]")?.textContent.includes("模拟章节保存失败")');
      ensure(await evaluate(editBody + '.value.endsWith("编辑失败后仍要保留的正文。") && ' + editTitle + '.value==="修改后的章节名" && resumeFixture.chapterEdits.size===0'), theme + ' failed chapter save retains both title and body');
      const light = await editorColors();
      ensure(JSON.stringify(light.surface) === JSON.stringify(light.expected), theme + ' editor surface follows reading palette with a light site theme', light);
      ensure(light.controls.every(c => c.ratio >= 4.5), theme + ' editor text, metadata, actions and errors retain readable contrast', light);
      await evaluate('document.documentElement.classList.add("dark")'); const dark = await editorColors();
      ensure(JSON.stringify(light) === JSON.stringify(dark), theme + ' editor controls keep their reading palette when the site theme changes', { light, dark });
      ensure(await evaluate('getComputedStyle(' + editBody + ').fontSize==="16px" && getComputedStyle(' + editTitle + ').fontSize==="16px"'), theme + ' touch editor fields avoid browser focus zoom');
      await screenshot('chapter-editor-' + theme);
      await closeEditor();
      ensure(Math.abs((await state()).top - 1230) <= 2 && await evaluate('document.activeElement?.getAttribute("aria-label")==="编辑本章"'), theme + ' closing chapter editor restores reading position and opener focus');
    }
    for (const [width, height, touch] of [[390, 844, true], [768, 1024, true], [1536, 864, false]]) {
      await fresh(width, height, touch); const position = await readAt(1760); await openEditor();
      const original = await evaluate(editBody + '.value'); await typeEdit(original + '\n\n确认后显示的新正文。');
      await evaluate('resumeFixture.holdEditor.save=true'); await click(saveEdit);
      await wait('resumeFixture.pendingEditors.some(r=>r.operation==="save")');
      await evaluate(saveEdit + '.click()');
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 2, y: 2 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 2, y: 2 });
      ensure(await evaluate(editor + '.getAttribute("aria-busy")==="true" && [...'+ editor + '.querySelectorAll("button,input,textarea")].every(e=>e.disabled) && resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1'), width + ' pending chapter save blocks duplicate requests and accidental dismissal');
      await evaluate('resumeFixture.holdEditor.save=false;resumeFixture.editorStatus.save=503;resumeFixture.pendingEditors.splice(0).forEach(r=>r.resolve())');
      await wait(editor + '?.querySelector("[role=alert]") && !' + saveEdit + '.disabled');
      ensure(await evaluate(editBody + '.value.endsWith("确认后显示的新正文。")'), width + ' delayed failure unlocks the intact chapter edit for retry');
      await evaluate('resumeFixture.editorStatus.save=0'); await click(saveEdit);
      await wait('!'+editor+' && document.querySelector(".reader-body-text")?.textContent.includes("确认后显示的新正文。")');
      ensure(await evaluate('resumeFixture.editorRequests.filter(r=>r.operation==="save").length===2 && resumeFixture.chapterEdits.get(1).content.endsWith("确认后显示的新正文。")'), width + ' retry writes the submitted edit once and refreshes visible text');
      ensure(Math.abs((await state()).top - position.top) <= 2, width + ' saving an appended correction preserves the visible passage', { position, after: await state() });
      await openEditor(); ensure(await evaluate(editBody + '.value.endsWith("确认后显示的新正文。")'), width + ' reopening chapter editor loads confirmed server text'); await closeEditor();
    }
    await fresh(390, 844, true); await readAt(1240);
    await evaluate('resumeFixture.editorStatus.load=503'); await reveal('[aria-label=编辑本章]'); await click('document.querySelector("[aria-label=编辑本章]")');
    await wait('document.body.innerText.includes("模拟章节加载失败")');
    ensure(await evaluate('!'+editor+' && !document.querySelector("[aria-label=编辑本章]").disabled && document.body.style.position!=="fixed"'), 'failed editor load leaves the reader usable and retryable');
    await evaluate('resumeFixture.editorStatus.load=0;resumeFixture.holdEditor.load=true');
    await reveal('[aria-label=编辑本章]'); await click('document.querySelector("[aria-label=编辑本章]")'); await wait('resumeFixture.pendingEditors.some(r=>r.operation==="load")');
    await click('document.querySelector("[aria-label=打开阅读设置]")'); await wait('!!document.querySelector(".reader-settings-panel")');
    await evaluate('resumeFixture.holdEditor.load=false;resumeFixture.pendingEditors.splice(0).forEach(r=>r.resolve())'); await sleep(200);
    ensure(await evaluate('!'+editor+' && !!document.querySelector(".reader-settings-panel") && resumeFixture.editorRequests.at(-1).signal.aborted'), 'late editor load cannot cover a newer reading settings action');
    await fresh(390, 844, true); await openEditor(); await evaluate('resumeFixture.holdEditor.save=true'); await click(saveEdit); await wait('resumeFixture.pendingEditors.length>0');
    await evaluate('resumeFixture.switchAccount("editor-other-user")'); await ready(1);
    await evaluate('resumeFixture.holdEditor.save=false;resumeFixture.pendingEditors.splice(0).forEach(r=>r.resolve())'); await sleep(200);
    ensure(await evaluate('!'+editor+' && !document.body.innerText.includes("已写入原 EPUB") && resumeFixture.editorRequests.filter(r=>r.operation==="load").length===1'), 'late old-account editor confirmation cannot reopen an editor or publish a success message');
    for (const [width, height] of [[320, 280], [640, 360], [390, 568]]) {
      await fresh(width, height, true, 'editableImages'); await openEditor();
      await evaluate('resumeFixture.editorStatus.save=503;resumeFixture.editorMessage="网络暂时不可用。".repeat(30)+"x".repeat(320);' + saveEdit + '.scrollIntoView({block:"nearest"})'); await sleep(80); await click(saveEdit);
      await wait('!!' + editor + '?.querySelector("[role=alert]")');
      ensure(await evaluate('(()=>{const d='+editor+',p=d.parentElement,s=getComputedStyle(d).overflowY==="auto"?d:d.querySelector(".overflow-y-auto");return d.scrollWidth<=d.clientWidth+1 && p.scrollWidth<=p.clientWidth+1 && !!s && s.scrollHeight>s.clientHeight})()'), width + 'x' + height + ' long editor errors and illustration guidance stay scrollable without horizontal overflow');
      await evaluate(saveEdit + '.scrollIntoView({block:"nearest"})'); await sleep(80);
      ensure(await evaluate('(()=>{const e='+saveEdit+',r=e.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()'), width + 'x' + height + ' failed save keeps its retry action reachable');
      await screenshot('chapter-editor-compact-' + width + '-' + height); await closeEditor();
      ensure(await evaluate('document.body.style.position!=="fixed"'), width + 'x' + height + ' compact editor keeps a reachable exit and releases scroll lock');
    }
  }
  if (editorOnly || (!startupOnly && !boundaryOnly && !mediaOnly && !raceOnly && !marksOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    const recovery = 'document.querySelector(".reader-mutation-recovery")';
    const reload = recovery + '.querySelector("button")';
    const startupRetry = 'document.querySelector(".reader-startup-state button")';
    const editor = 'document.querySelector("[aria-labelledby=edit-chapter-title]")';
    const save = 'document.querySelector(".chapter-editor-save")';
    const openEditor = async () => { await reveal('[aria-label=编辑本章]'); await click('document.querySelector("[aria-label=编辑本章]")'); await wait('!!' + editor); await sleep(150); };
    const commitSave = async (failure) => {
      await openEditor();
      await evaluate(editor + '.querySelector("textarea").focus()'); await command('Input.insertText', { text: '恢复后确认的新正文。' });
      await evaluate(failure + ';' + save + '.scrollIntoView({block:"nearest"})'); await sleep(80); await click(save);
      await wait('!!' + recovery);
    };
    for (const [width, height, touch, theme, paged, failure] of [
      [390, 844, true, 'dark', false, 'resumeFixture.failChapter=1'],
      [768, 1024, true, 'white', true, 'resumeFixture.resourceStatus=503'],
      [1536, 864, false, 'paper', false, 'resumeFixture.resourceStatus=503'],
      [320, 280, true, 'green', true, 'resumeFixture.failChapter=1'],
    ]) {
      const label = width + ' ' + theme;
      await fresh(width, height, touch, 'theme=' + theme + (paged ? '&paged' : ''));
      await readAt(1760); await evaluate('resumeFixture.flush()'); await commitSave(failure);
      ensure(await evaluate('!!document.querySelector(".reader-mutation-recovery[role=alert]") && ' + reload + '.textContent.includes("重新加载") && !document.querySelector(".reader-body-text") && !' + editor), label + ' committed save exposes actionable recovery instead of stale text');
      ensure(await evaluate('document.activeElement===' + recovery + ' && document.body.style.position!=="fixed" && getComputedStyle(' + recovery + ').outlineStyle==="none"'), label + ' recovery receives announcement focus without a control outline after modal unlock');
      const palette = await evaluate('(()=>{const s=getComputedStyle(' + recovery + '.closest("main"));return [s.backgroundColor,s.color,s.getPropertyValue("--reader-shell"),s.getPropertyValue("--reader-ink")]})()');
      await evaluate('document.documentElement.classList.add("dark")');
      ensure(JSON.stringify(palette) === JSON.stringify(await evaluate('(()=>{const s=getComputedStyle(' + recovery + '.closest("main"));return [s.backgroundColor,s.color,s.getPropertyValue("--reader-shell"),s.getPropertyValue("--reader-ink")]})()')), label + ' recovery follows the reading palette independently of the site theme');
      await evaluate(reload + '.scrollIntoView({block:"nearest"})'); await sleep(80);
      ensure(await evaluate('(()=>{const e=' + reload + ',r=e.getBoundingClientRect(),p=' + recovery + '.closest("main");return r.top>=0 && r.bottom<=innerHeight && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) && p.scrollWidth<=p.clientWidth+1})()'), label + ' recovery retry remains reachable without horizontal overflow');
      const attempts = await evaluate('resumeFixture.attempts.length');
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
      await evaluate('window.dispatchEvent(new Event("pagehide"));resumeFixture.flush()'); await sleep(150);
      ensure(await evaluate('resumeFixture.attempts.length') === attempts && await evaluate('!!' + recovery), label + ' recovery blocks stale reading writes and chapter shortcuts');
      await screenshot('chapter-recovery-' + theme);
      await evaluate('resumeFixture.startupStatus=503'); await click(reload); await wait('!!document.querySelector(".reader-startup-state[role=alert]")');
      ensure(await evaluate('!document.querySelector(".reader-body-text") && resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1 && resumeFixture.startupRequests.length>1 && resumeFixture.attempts.length===' + attempts), label + ' failed reload remains safe and never resubmits the chapter edit', await evaluate('({mutations:resumeFixture.editorRequests.map(r=>r.operation),reads:resumeFixture.startupRequests.length,attempts:resumeFixture.attempts.length})'));
      await evaluate('resumeFixture.startupStatus=-1'); await click(startupRetry); await wait('document.querySelector(".reader-startup-state[role=alert]")?.textContent.includes("网络")');
      ensure(await evaluate('!document.querySelector(".reader-body-text") && resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1'), label + ' disconnected retry retains an exit and a GET-only retry');
      const readsBeforeSuccess = await evaluate('resumeFixture.startupRequests.length');
      await evaluate('resumeFixture.startupStatus=0;resumeFixture.resourceStatus=0;resumeFixture.failChapter=0'); await click(startupRetry); await ready(1);
      ensure(await evaluate('document.querySelector(".reader-body-text").textContent.includes("恢复后确认的新正文。") && !'+recovery+' && resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1 && resumeFixture.startupRequests.length===' + (readsBeforeSuccess + 1)), label + ' successful retry displays confirmed text without a duplicate mutation');
      await readAt(1200); await evaluate('resumeFixture.flush()');
      ensure(await evaluate('resumeFixture.attempts.length>' + attempts), label + ' fresh reader resumes normal progress persistence');
      await openEditor(); await evaluate(save + '.scrollIntoView({block:"nearest"})'); await sleep(80); await click(save);
      await wait('!!document.querySelector(".reader-toast-safe[role=status]")');
      ensure(await evaluate('document.querySelector(".reader-toast-safe").classList.contains("reader-inline-message") && document.querySelector(".reader-toast-safe").closest(".reader-theme-' + theme + '")!==null'), label + ' ordinary edit confirmation has status semantics and follows the reading theme');
    }
    for (const deletedIndex of [1, 3]) {
      await fresh(390, 844, true);
      if (deletedIndex !== 1) { await select(deletedIndex); await ready(deletedIndex); }
      await readAt(1760); await evaluate('resumeFixture.flush()'); await openEditor();
      await evaluate('window.confirm=()=>true;resumeFixture.resourceStatus=503;document.querySelector(".chapter-editor-delete").scrollIntoView({block:"nearest"})'); await sleep(80); await click('document.querySelector(".chapter-editor-delete")'); await wait('!!' + recovery);
      const attempts = await evaluate('resumeFixture.attempts.length'), nextIndex = Math.min(deletedIndex, 2), sourceIndex = 2;
      ensure(await evaluate('document.body.innerText.includes("章节已删除") && !document.querySelector(".reader-body-text") && resumeFixture.editorRequests.filter(r=>r.operation==="remove").length===1 && resumeFixture.progress().position_key==="key-' + sourceIndex + '"'), 'deleting chapter ' + deletedIndex + ' preserves confirmed deletion and shows recovery');
      await evaluate('resumeFixture.startupStatus=503'); await click(reload); await wait('!!document.querySelector(".reader-startup-state[role=alert]")');
      ensure(await evaluate('resumeFixture.attempts.length===' + attempts + ' && resumeFixture.startupRequests.at(-1).chapterIndex===' + nextIndex), 'deleting chapter ' + deletedIndex + ' retries the server-confirmed remaining index without writing the deleted position');
      await evaluate('resumeFixture.startupStatus=0;resumeFixture.resourceStatus=0'); await click(startupRetry);
      await wait('document.querySelector(".reader-chapter-heading h1")?.textContent==="第' + sourceIndex + '话" && document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');
      ensure(await evaluate('resumeFixture.editorRequests.filter(r=>r.operation==="remove").length===1 && resumeFixture.progress().chapter_index===' + nextIndex + ' && new URLSearchParams(location.search).get("chapter")==="' + nextIndex + '" && !'+recovery), 'deleting chapter ' + deletedIndex + ' restores the remaining stable chapter and synchronizes its URL');
    }
    for (const leaveDuringReload of [false, true]) {
      await fresh(390, 844, true, 'collection=public'); await commitSave('resumeFixture.resourceStatus=503');
      if (leaveDuringReload) {
        await evaluate('resumeFixture.holdStartup=true'); await click(reload); await wait('resumeFixture.pendingStartups.length===1');
        await click('document.querySelector(".reader-state-return")');
      } else await click(recovery + '.querySelector("a")');
      await wait('!!document.querySelector("#reopen")');
      if (leaveDuringReload) { await evaluate('resumeFixture.holdStartup=false;resumeFixture.pendingStartups.splice(0).forEach(r=>r())'); await sleep(200); }
      ensure(await evaluate('!!document.querySelector("#reopen") && !'+recovery+' && !document.querySelector(".reader-body-text") && document.querySelector("#fixture-location-state").textContent.includes("/public")'), (leaveDuringReload ? 'late recovery response' : 'recovery exit') + ' preserves the detail destination and collection return');
      ensure(await evaluate('resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1' + (leaveDuringReload ? ' && resumeFixture.startupRequests.at(-1).signal.aborted' : '')), 'leaving recovery ' + leaveDuringReload + ' never repeats a mutation or accepts an aborted startup');
    }
    await fresh(390, 844, true); await commitSave('resumeFixture.failChapter=1');
    await evaluate('resumeFixture.holdStartup=true'); await click(reload); await wait('resumeFixture.pendingStartups.length===1');
    await evaluate('resumeFixture.switchAccount("recovery-other-user")'); await wait('resumeFixture.pendingStartups.length===2');
    await evaluate('resumeFixture.holdStartup=false;resumeFixture.pendingStartups.splice(0).forEach(r=>r())'); await ready(1);
    ensure(await evaluate('!'+recovery+' && resumeFixture.startupRequests.at(-2).signal.aborted && resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1'), 'old-account recovery response cannot reopen recovery or replay a save in the next account');
  }
  }
  if (mutationRetryOnly) {
    const dialog = 'document.querySelector("[role=dialog]")';
    const input = dialog + '.querySelector("textarea")';
    const fill = async (target, text) => { await evaluate(target + '.focus();' + target + '.select()'); await command('Input.insertText', { text }); await sleep(60); };
    const submitFor = operation => operation === 'append' ? 'Array.from('+dialog+'.querySelectorAll("button")).at(-1)'
      : 'document.querySelector(".chapter-editor-' + (operation === 'remove' ? 'delete' : 'save') + '")';
    const open = async (surface, operation, width, height, touch) => {
      await fresh(width, height, touch, surface === 'detail' ? 'detail&siteDark' : 'theme=dark', surface !== 'detail');
      if (surface === 'detail') {
        await wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false" && document.querySelectorAll(".book-detail-catalog-content a").length===3');
        const trigger = operation === 'append' ? 'Array.from(document.querySelectorAll(".book-detail-actions button")).find(e=>e.textContent.trim()==="追加章节")'
          : 'document.querySelectorAll(".book-detail-catalog-content button[aria-label^=编辑]")[1]';
        await evaluate(trigger + '.scrollIntoView({block:"center"})'); await sleep(80); await click(trigger);
      } else {
        await select(2); await ready(2);
        await reveal('[aria-label=编辑本章]'); await click('document.querySelector("[aria-label=编辑本章]")');
      }
      await wait('!!'+dialog+'?.querySelector("textarea")');
      await evaluate('window.confirm=()=>true');
      if (operation !== 'remove') await fill(input, '连接恢复后仍然完整的正文。');
      await evaluate(submitFor(operation) + '.scrollIntoView({block:"nearest"})'); await sleep(60);
    };
    for (const [width, height, touch] of [[390,844,true],[768,1024,true],[1536,864,false]]) {
      for (const surface of ['reader','detail']) for (const operation of surface === 'reader' ? ['save','remove'] : ['append','save','remove']) {
        for (const afterCommit of [false,true]) {
          const label = width + ' ' + surface + ' ' + operation + (afterCommit ? ' lost acknowledgement' : ' interrupted before commit');
          await open(surface, operation, width, height, touch);
          const draft = await evaluate(input + '.value');
          await evaluate('resumeFixture.editorStatus.'+operation+'='+(afterCommit ? '-2' : '-1'));
          await click(submitFor(operation));
          await wait(dialog+'?.querySelector("[role=alert]")?.textContent.includes("结果未确认")');
          const count = operation === 'append' ? 4 : operation === 'remove' ? 2 : 3;
          ensure(await evaluate(input+'.value==='+JSON.stringify(draft)+' && !'+submitFor(operation)+'.disabled && resumeFixture.resource.chapter_count==='+ (afterCommit ? count : 3)), label + ' retains the editable draft while accurately modelling the server outcome');
          ensure(await evaluate('(()=>{const r=resumeFixture.editorRequests.filter(r=>r.operation==="'+operation+'")[0];return /^[0-9a-f-]{36}$/.test(r.requestId) && '+(operation === 'append' ? 'r.revision===null' : '/^"[0-9a-f]{64}"$/.test(r.revision)')+'})()'), label + ' sends a reserved request identity and the loaded chapter revision');
          if (afterCommit) await screenshot('chapter-uncertain-'+width+'-'+surface+'-'+operation);
          if (!afterCommit) await evaluate('resumeFixture.editorStatus.'+operation+'=0');
          await click(submitFor(operation)); await wait('!'+dialog);
          await wait('resumeFixture.resource.chapter_count==='+count+' && '+(surface === 'detail' ? '!document.querySelector(".book-detail-chapter-refresh") && document.querySelectorAll(".book-detail-catalog-content a").length==='+count : '!!document.querySelector(".reader-body-text")'));
          ensure(await evaluate('(()=>{const requests=resumeFixture.editorRequests.filter(r=>r.operation==="'+operation+'");return requests.length===2 && requests[0].requestId===requests[1].requestId && requests[0].revision===requests[1].revision && resumeFixture.editorReceipts.size===1})()'), label + ' retry confirms the original operation without executing another write');
          ensure(await evaluate('resumeFixture.resource.toc.some(c=>c.title==="第3话") && '+(operation === 'save' ? 'resumeFixture.chapterEdits.get(2).content.includes("连接恢复后仍然完整的正文")' : operation === 'remove' ? 'resumeFixture.resource.toc[1].title==="第3话"' : 'resumeFixture.chapterEdits.get(4).content.includes("连接恢复后仍然完整的正文")')+' && document.documentElement.scrollWidth<=innerWidth+1'), label + ' preserves the following chapter and publishes the confirmed content');
        }
      }
    }
    for (const surface of ['reader','detail']) for (const operation of ['save','remove']) {
      await open(surface, operation, 768, 1024, true);
      const draft = await evaluate(input+'.value');
      await evaluate('resumeFixture.chapterEdits.set(2,{content:"其他窗口保存的正文。",title:"第2话"})');
      await click(submitFor(operation));
      await wait(dialog+'?.querySelector("[role=alert]")?.textContent.includes("本次操作未执行")');
      ensure(await evaluate(input+'.value==='+JSON.stringify(draft)+' && !'+dialog+'.querySelector("[role=alert]").textContent.includes("结果未确认") && resumeFixture.editorReceipts.size===0 && resumeFixture.resource.chapter_count===3 && resumeFixture.chapterEdits.get(2).content==="其他窗口保存的正文。"'), surface+' '+operation+' rejects a stale editor explicitly and preserves its draft and the external change');
    }
    await verifyChapterMutationReload({ command, ensure, evaluate, fresh, ready });
  }
  if (detailOnly || (!chromeOnly && !detailMutationOnly && !detailProgressOnly && !startupOnly && !boundaryOnly && !mediaOnly && !raceOnly && !marksOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    const catalog = 'document.querySelector(".book-detail-catalog")';
    const catalogError = 'document.querySelector(".book-detail-catalog-error")';
    const retryCatalog = catalogError + '.querySelector("button")';
    const toolsStatus = 'document.querySelector(".book-detail-chapter-tools-status")';
    const retryTools = toolsStatus + '.querySelector("button")';
    const detailReady = () => wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false"');
    const openDetail = async (w, h, touch, options = '') => { await fresh(w, h, touch, 'detail&' + options, false); await detailReady(); };
    const scrollTo = async (target) => { await evaluate(target + '.scrollIntoView({block:"center"})'); await sleep(120); };
    for (const [width, height, touch] of [[390, 844, true], [768, 1024, true], [1536, 864, false]]) for (const dark of [false, true]) {
      const label = width + (dark ? ' dark' : ' light');
      await openDetail(width, height, touch, 'resourceError=503' + (dark ? '&siteDark' : ''));
      ensure(await evaluate('!!' + catalogError + ' && ' + catalogError + '.getAttribute("role")==="alert" && !document.body.innerText.includes("这本书还没有可显示的在线目录") && document.body.innerText.includes("资源读取失败")'), label + ' failed catalogue read exposes a retry instead of an empty book or endless loading');
      await scrollTo(retryCatalog); await screenshot('book-detail-catalog-error-' + label.replace(' ', '-'));
      const reads = await evaluate('resumeFixture.detailReads.length');
      const otherReads = await evaluate('resumeFixture.detailReads.filter(r=>r.operation!=="resource").length');
      await evaluate('resumeFixture.holdDetail.resource=true'); await click(retryCatalog); await wait('resumeFixture.pendingDetails.length===1');
      ensure(await evaluate('!!document.querySelector(".book-detail-page h1") && !!document.querySelector(".book-detail-catalog-loading[role=status]") && document.querySelector(".book-detail-page").dataset.navigationLoading==="false" && resumeFixture.detailReads.length===' + (reads + 1)), label + ' catalogue retry retains the loaded page and starts one read');
      await evaluate('resumeFixture.detailStatus.resource=-1;resumeFixture.holdDetail.resource=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())');
      await wait('!!' + catalogError);
      ensure(await evaluate('document.activeElement===' + retryCatalog + ' && resumeFixture.detailReads.filter(r=>r.operation!=="resource").length===' + otherReads + ' && resumeFixture.editorRequests.length===0'), label + ' disconnected retry restores its action focus and leaves unrelated sections intact');
      await evaluate('resumeFixture.detailStatus.resource=0'); await click(retryCatalog); await wait('!!document.querySelector(".book-detail-catalog-content a")');
      ensure(await evaluate('!'+catalogError+' && document.querySelectorAll(".book-detail-catalog-content a").length===3 && document.activeElement===document.querySelector(".book-detail-catalog-content a") && !document.body.innerText.includes("资源读取失败")'), label + ' successful catalogue retry restores all chapter links and moves focus into the loaded catalogue');
      ensure(await evaluate('resumeFixture.detailReads.filter(r=>r.operation!=="resource").length===' + otherReads + ' && resumeFixture.editorRequests.length===0'), label + ' catalogue recovery only reloads the failed read');
      await openDetail(width, height, touch, 'chaptersError=503' + (dark ? '&siteDark' : ''));
      ensure(await evaluate('!!' + toolsStatus + ' && document.querySelectorAll(".book-detail-catalog-content a").length===3 && document.querySelectorAll(".book-detail-catalog-content button[aria-label^=编辑]").length===0'), label + ' missing editor permissions read is explained while chapter reading remains available');
      await scrollTo(retryTools); const resourceReads = await evaluate('resumeFixture.detailReads.filter(r=>r.operation==="resource").length');
      await evaluate('resumeFixture.holdDetail.chapters=true;resumeFixture.detailStatus.chapters=0'); await click(retryTools); await wait('resumeFixture.pendingDetails.length===1');
      ensure(await evaluate(retryTools + '.disabled && document.querySelectorAll(".book-detail-catalog-content a").length===3 && document.querySelector(".book-detail-page").dataset.navigationLoading==="false"'), label + ' editor-entry retry retains the catalogue and disables duplicate retries');
      await evaluate('resumeFixture.holdDetail.chapters=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())');
      await wait('document.querySelectorAll(".book-detail-catalog-content button[aria-label^=编辑]").length===3');
      ensure(await evaluate('!'+toolsStatus+' && document.activeElement===document.querySelector(".book-detail-catalog-content button[aria-label^=编辑]") && resumeFixture.detailReads.filter(r=>r.operation==="resource").length===' + resourceReads), label + ' editor-entry retry restores editable chapters without rereading the catalogue');
      await evaluate(catalog + '.scrollIntoView({block:"center"})');
      ensure(await evaluate('document.documentElement.scrollWidth<=innerWidth+1 && [...'+catalog+'.querySelectorAll("a,button")].every(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1})'), label + ' recovered catalogue links and edit controls fit the viewport without horizontal overflow');
    }
    await openDetail(390, 844, true, 'resourceError=503'); await scrollTo(retryCatalog);
    await evaluate('resumeFixture.detailStatus.resource=0;resumeFixture.holdDetail.resource=true'); await click(retryCatalog); await wait('resumeFixture.pendingDetails.length===1');
    const appendTrigger = 'Array.from(document.querySelectorAll(".book-detail-actions button")).find(e=>e.textContent.trim()==="追加章节")';
    await scrollTo(appendTrigger); await click(appendTrigger); await wait('!!document.querySelector("[aria-labelledby=append-chapter-title]")'); await sleep(100);
    await command('Input.insertText', { text: '还在编写的正文草稿。' });
    await evaluate('resumeFixture.holdDetail.resource=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())'); await wait('!!document.querySelector(".book-detail-catalog-content a")');
    ensure(await evaluate('document.activeElement===document.querySelector("[aria-labelledby=append-chapter-title] textarea") && document.activeElement.value==="还在编写的正文草稿。" && document.body.style.position==="fixed"'), 'background catalogue recovery never steals focus from a newer chapter draft dialog');
    await click('document.querySelector("[aria-label=关闭追加章节]")');
    for (const section of ['resource', 'chapters']) {
      await openDetail(390, 844, true, section === 'resource' ? 'resourceError=503&collection=public' : 'chaptersError=503&collection=public');
      const target = section === 'resource' ? retryCatalog : retryTools;
      await scrollTo(target); await evaluate('resumeFixture.detailStatus.' + section + '=0;resumeFixture.holdDetail.' + section + '=true'); await click(target); await wait('resumeFixture.pendingDetails.length===1');
      await evaluate('fixtureNavigate("/public?q=test",{state:{collectionReturn:{pathname:"/public",search:"?q=test",key:"detail-return"}}})'); await wait('!!document.querySelector("#collection-return")');
      await evaluate('resumeFixture.holdDetail.' + section + '=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())'); await sleep(200);
      ensure(await evaluate('!!document.querySelector("#collection-return") && !document.querySelector(".book-detail-page") && resumeFixture.detailReads.filter(r=>r.operation==="'+section+'").at(-1).signal.aborted'), 'leaving a pending ' + section + ' retry aborts its request and cannot reopen the old detail page');
    }
    await openDetail(390, 844, true, 'resourceError=503'); await scrollTo(retryCatalog);
    await evaluate('resumeFixture.detailStatus.resource=0;resumeFixture.holdDetail.resource=true'); await click(retryCatalog); await wait('resumeFixture.pendingDetails.length===1');
    await evaluate('resumeFixture.resource.toc[0].title="新账号章节";resumeFixture.switchAccount("detail-other-user")'); await wait('resumeFixture.pendingDetails.length===2');
    await evaluate('resumeFixture.pendingDetails.pop().resolve()'); await detailReady(); await wait('document.querySelector(".book-detail-catalog-content")?.textContent.includes("新账号章节")');
    await evaluate('resumeFixture.holdDetail.resource=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())'); await sleep(200);
    ensure(await evaluate('document.querySelector(".book-detail-catalog-content").textContent.includes("新账号章节") && resumeFixture.detailReads.filter(r=>r.operation==="resource" && r.scope.includes("resume-test-user")).at(-1).signal.aborted'), 'late old-account catalogue retry cannot overwrite the next account catalogue');
    await openDetail(390, 844, true, 'emptyCatalog');
    ensure(await evaluate('!'+catalogError+' && document.body.innerText.includes("这本书还没有可显示的在线目录") && !document.querySelector(".book-detail-catalog-loading")'), 'a confirmed empty catalogue keeps an honest empty state');
    await openDetail(390, 844, true, 'publicDetail&chaptersError=403');
    ensure(await evaluate('!'+toolsStatus+' && document.querySelectorAll(".book-detail-catalog-content a").length===3 && !document.querySelector(".book-detail-catalog-content button[aria-label^=编辑]")'), 'a shared book does not show private editing failures as a broken feature');
  }
  if (detailProgressOnly || (!detailOnly && !chromeOnly && !detailMutationOnly && !startupOnly && !boundaryOnly && !mediaOnly && !raceOnly && !marksOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    const status = 'document.querySelector(".book-detail-progress-status")';
    const retry = status + '.querySelector("button")';
    const region = 'document.querySelector(".book-detail-reading-progress")';
    const percent = 'document.querySelector(".book-detail-progress [role=progressbar]")?.getAttribute("aria-valuenow")';
    const currentChapter = 'document.querySelector(".book-detail-catalog-content [aria-current=page]")';
    const append = 'Array.from(document.querySelectorAll(".book-detail-actions button")).find(e=>e.textContent.trim()==="追加章节")';
    const detailReady = () => wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false"');
    const open = async (width = 390, height = 844, touch = true, options = 'detailProgress=60&progressError=503') => { await fresh(width, height, touch, 'detail&' + options, false); await detailReady(); };
    const scrollTo = async target => { await evaluate(target + '.scrollIntoView({block:"center"})'); await sleep(100); };
    const holdRetry = async () => { await scrollTo(retry); await evaluate('resumeFixture.holdDetail.progress=true'); await click(retry); await wait('resumeFixture.pendingDetails.length===1'); };
    const release = async code => { await evaluate(code + ';resumeFixture.holdDetail.progress=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())'); };
    for (const [width, height, touch] of [[390, 844, true], [768, 1024, true], [1536, 864, false]]) for (const dark of [false, true]) {
      const label = width + (dark ? ' dark' : ' light') + ' detail progress';
      await open(width, height, touch, 'detailProgress=60&progressError=503' + (dark ? '&siteDark' : ''));
      ensure(await evaluate(percent+'==="60" && !!'+status+' && !'+currentChapter+' && document.querySelectorAll(".book-detail-catalog-content a").length===3 && document.querySelectorAll(".book-detail-catalog-content button[aria-label^=编辑]").length===3'), label + ' failed location preserves the known percentage and catalogue without guessing the current chapter');
      const retryFits = await evaluate('(()=>{const r='+retry+'.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && r.height>=40})()');
      await scrollTo(retry); await screenshot('detail-progress-failure-' + width + (dark ? '-dark' : '-light'));
      const otherReads = await evaluate('resumeFixture.detailReads.filter(r=>r.operation!=="progress").length');
      const progressReads = await evaluate('resumeFixture.detailReads.filter(r=>r.operation==="progress").length');
      await holdRetry(); await click(retry);
      ensure(await evaluate(retry+'.disabled && '+region+'.getAttribute("aria-busy")==="true" && '+percent+'==="60" && resumeFixture.detailReads.filter(r=>r.operation==="progress").length==='+(progressReads+1)+' && document.querySelectorAll(".book-detail-catalog-content a").length===3'), label + ' pending retry retains content and prevents duplicate progress requests');
      await release('resumeFixture.detailStatus.progress=-1'); await wait('!!'+status+' && !'+retry+'.disabled'); await wait('document.activeElement==='+retry);
      ensure(await evaluate(percent+'==="60" && !'+currentChapter+' && document.activeElement==='+retry), label + ' disconnected retry retains known progress and restores its retry focus');
      await evaluate('resumeFixture.detailStatus.progress=0'); await click(retry); await wait('!'+status+' && !!'+currentChapter); await wait('document.activeElement==='+region);
      ensure(await evaluate(percent+'==="60" && '+currentChapter+'.textContent.includes("第1话") && '+region+'.getAttribute("aria-busy")==="false" && document.activeElement==='+region), label + ' successful retry restores the actual weighted chapter and focuses the loaded progress');
      ensure(await evaluate('resumeFixture.detailReads.filter(r=>r.operation!=="progress").length==='+otherReads+' && resumeFixture.editorRequests.length===0 && resumeFixture.readingStatusWrites.length===0 && resumeFixture.attempts.length===0'), label + ' independent progress recovery performs only the required reads');
      ensure(retryFits && await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), label + ' progress and retry fit the viewport');
    }
    for (const [format, options] of [
      ['PDF', 'pdf'], ['comic', 'readableManga'], ['image', 'readableImage'], ['unsupported', 'unsupported'],
      ['shared EPUB', 'publicDetail'], ['processing EPUB', 'bookStatus=processing'], ['uploading EPUB', 'bookStatus=uploading'], ['failed EPUB', 'bookStatus=failed'],
    ]) {
      await open(390, 844, true, options + '&chaptersError=503');
      ensure(await evaluate('resumeFixture.detailReads.every(r=>r.operation!=="chapters") && !document.querySelector(".book-detail-chapter-tools-status")'), format + ' initial detail never requests inapplicable chapter editing');
      await evaluate('resumeFixture.book.title="已刷新 '+format+'";window.dispatchEvent(new CustomEvent("aisu:reading-progress-saved"))');
      await wait('document.querySelector(".book-detail-page h1")?.textContent==="已刷新 '+format+'"');
      ensure(await evaluate('resumeFixture.detailReads.every(r=>r.operation!=="chapters") && !document.body.innerText.includes("目录更新暂时失败")'), format + ' coherent background refresh succeeds without unused editing dependencies');
      if (format === 'PDF' || format === 'unsupported') ensure(await evaluate('document.body.innerText.includes('+JSON.stringify(format === 'PDF' ? 'PDF 目录和页码请在阅读器中查看。' : '当前格式暂不支持在线目录。')+') && !document.body.innerText.includes("这本书还没有可显示的在线目录")'), format + ' catalogue wording describes the format accurately');
    }
    await open(390, 844, true, 'textBook');
    ensure(await evaluate('resumeFixture.detailReads.some(r=>r.operation==="chapters") && document.querySelectorAll(".book-detail-catalog-content button[aria-label^=编辑]").length===3'), 'ready owned text books retain their chapter editing controls');
    await open(); await holdRetry();
    await evaluate('fixtureNavigate("/public?q=test")'); await wait('!!document.querySelector("#collection-return")'); await release('resumeFixture.detailStatus.progress=0'); await sleep(200);
    ensure(await evaluate('!!document.querySelector("#collection-return") && !document.querySelector(".book-detail-page") && resumeFixture.detailReads.filter(r=>r.operation==="progress").at(-1).signal.aborted'), 'leaving progress retry aborts its request and ignores late location responses');
    await open(); await holdRetry();
    await evaluate('resumeFixture.detailStatus.progress=0;resumeFixture.book.title="新账号的阅读位置";resumeFixture.book.progress_percent=90;Object.assign(resumeFixture.progress(),{chapter_index:3,position_key:"key-3",progress_percent:90,updated_at:new Date().toISOString()});resumeFixture.switchAccount("progress-next-user")');
    await wait('resumeFixture.pendingDetails.length===2'); await evaluate('resumeFixture.pendingDetails.pop().resolve()'); await detailReady(); await wait(percent+'==="90" && '+currentChapter+'?.textContent.includes("第3话")');
    await release('resumeFixture.detailStatus.progress=0'); await sleep(200);
    ensure(await evaluate(percent+'==="90" && '+currentChapter+'.textContent.includes("第3话") && document.querySelector(".book-detail-page h1").textContent==="新账号的阅读位置" && resumeFixture.detailReads.filter(r=>r.operation==="progress" && r.scope.includes("resume-test-user")).at(-1).signal.aborted'), 'late old-account progress cannot replace the next account percentage or chapter');
    for (const [initial, target, action] of [[60, 100, '标记已读'], [100, 0, '标记未读']]) {
      await open(390, 844, true, 'detailProgress='+initial+'&progressError=503'); await holdRetry();
      await evaluate('resumeFixture.heldReadingRequest=resumeFixture.detailReads.filter(r=>r.operation==="progress").at(-1);resumeFixture.detailStatus.progress=0;resumeFixture.holdDetail.progress=false');
      const toggle = 'Array.from(document.querySelectorAll(".book-detail-actions button")).find(e=>e.textContent.trim()==="'+action+'")';
      await scrollTo(toggle); await click(toggle); await wait(percent+'==="'+target+'" && !'+status);
      await release('resumeFixture.detailStatus.progress=0'); await sleep(200);
      ensure(await evaluate(percent+'==="'+target+'" && !'+status+' && resumeFixture.heldReadingRequest.signal.aborted && resumeFixture.readingStatusWrites.length===1'), action + ' confirmation supersedes a held old location without a progress rollback');
    }
    await open(); await holdRetry();
    await scrollTo(append); await click(append); await wait('!!document.querySelector("[aria-labelledby=append-chapter-title]")');
    const draft = 'document.querySelector("[aria-labelledby=append-chapter-title] textarea")';
    await evaluate(draft+'.focus()'); await command('Input.insertText', { text: '进度恢复时保留正在输入的草稿。' });
    await release('resumeFixture.detailStatus.progress=0'); await wait('!'+status);
    ensure(await evaluate('document.activeElement==='+draft+' && '+draft+'.value==="进度恢复时保留正在输入的草稿。" && document.body.style.position==="fixed"'), 'progress retry never steals focus or text from a newer chapter draft');
    await click('document.querySelector("[aria-label=关闭追加章节]")');
    await open();
    await evaluate('resumeFixture.holdWrites=true;import("/src/modules/reader/services/readingProgressSync.ts").then(m=>{void m.queueReadingProgressSync("resume-test",{bookId:"resume-test",readerType:"epub",chapterIndex:3,positionKey:"key-3",epubCfi:"aisu-scroll:0.5",progressPercent:95,updatedAt:new Date().toISOString()});return true})');
    await wait(percent+'==="95" && '+currentChapter+'?.textContent.includes("第3话")');
    ensure(await evaluate('!!'+status+' && '+percent+'==="95" && '+currentChapter+'.textContent.includes("第3话")'), 'a verified pending local location remains visible while its server location read is unavailable');
  }
  if (detailMutationOnly || (!detailOnly && !chromeOnly && !detailProgressOnly && !startupOnly && !boundaryOnly && !mediaOnly && !raceOnly && !marksOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    const recovery = 'document.querySelector(".book-detail-chapter-refresh")';
    const retry = recovery + '.querySelector("button")';
    const catalogLinks = 'document.querySelectorAll(".book-detail-catalog-content a")';
    const append = 'Array.from(document.querySelectorAll(".book-detail-actions button")).find(e=>e.textContent.trim()==="追加章节")';
    const detailReady = () => wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false"');
    const open = async (width = 390, height = 844, touch = true, dark = false) => { await fresh(width, height, touch, 'detail' + (dark ? '&siteDark' : ''), false); await detailReady(); };
    const scrollTo = async target => { await evaluate(target + '.scrollIntoView({block:"center"})'); await sleep(100); };
    const fill = async (target, text) => { await evaluate(target + '.focus();' + target + '.select()'); await command('Input.insertText', { text }); await sleep(80); };
    const startMutation = async operation => {
      if (operation === 'append') {
        await scrollTo(append); await click(append); await wait('!!document.querySelector("[aria-labelledby=append-chapter-title]")');
        await fill('document.querySelector("[aria-labelledby=append-chapter-title] textarea")', '新追加的话，正文完整保留。');
        await fill('document.querySelector("[aria-labelledby=append-chapter-title] input")', '第4话');
      } else {
        const edit = 'document.querySelectorAll(".book-detail-catalog-content button[aria-label^=编辑]")[1]';
        await scrollTo(edit); await click(edit); await wait('!!document.querySelector(".chapter-editor-dialog")');
        if (operation === 'save') await fill('document.querySelector(".chapter-editor-dialog input")', '第2话·修订');
      }
      await evaluate('resumeFixture.holdEditor.' + operation + '=true;window.confirm=()=>true');
      const submit = operation === 'append' ? 'Array.from(document.querySelectorAll("[aria-labelledby=append-chapter-title] button")).at(-1)'
        : operation === 'save' ? 'document.querySelector(".chapter-editor-save")' : 'document.querySelector(".chapter-editor-delete")';
      await click(submit); await wait('resumeFixture.pendingEditors.length===1'); await click(submit);
    };
    const releaseMutation = async operation => { await evaluate('resumeFixture.holdEditor.' + operation + '=false;resumeFixture.pendingEditors.splice(0).forEach(r=>r.resolve())'); };
    const failed = async (focus = true) => {
      await wait('!!' + recovery + ' && ' + recovery + '.textContent.includes("暂时刷新失败")');
      if (focus) await wait('document.activeElement==='+retry);
    };
    for (const [width, height, touch] of [[390, 844, true], [768, 1024, true], [1536, 864, false]]) for (const dark of [false, true]) for (const operation of ['append', 'save', 'remove']) {
      const label = width + (dark ? ' dark ' : ' light ') + operation;
      await open(width, height, touch, dark); await startMutation(operation);
      ensure(await evaluate('resumeFixture.editorRequests.filter(r=>r.operation==="'+operation+'").length===1 && document.querySelector("[role=dialog] button").disabled'), label + ' repeated submission starts one pending chapter write');
      const section = operation === 'append' ? 'book' : operation === 'save' ? 'resource' : 'chapters';
      await evaluate('resumeFixture.detailStatus.' + section + '=503'); await releaseMutation(operation); await failed();
      ensure(await evaluate('!!document.querySelector(".book-detail-page h1") && document.querySelector(".book-detail-page").dataset.navigationLoading==="false" && !document.querySelector("[role=dialog]") && document.body.style.position!=="fixed" && '+recovery+'.textContent.includes('+JSON.stringify(operation === 'append' ? '已追加' : operation === 'save' ? '已将' : '已从原书删除')+')'), label + ' confirmed write retains the book and its outcome when refresh fails');
      ensure(await evaluate(catalogLinks + '.length===0 && '+append+'.disabled && '+recovery+'.getAttribute("role")==="status" && document.activeElement==='+retry), label + ' recovery receives focus and prevents actions on obsolete chapter numbers');
      await scrollTo(retry); await screenshot('detail-chapter-refresh-' + label.replaceAll(' ', '-'));
      await evaluate('resumeFixture.detailStatus.'+section+'=0;resumeFixture.holdDetail.resource=true;resumeFixture.book.title="已更新的目录版本"');
      await click(retry); await wait('resumeFixture.pendingDetails.some(r=>r.operation==="resource")');
      ensure(await evaluate(retry+'.disabled && '+catalogLinks+'.length===0 && document.querySelector(".book-detail-page h1").textContent==="续读回归用书"'), label + ' pending retry keeps the previous summary until all reads succeed');
      await evaluate('resumeFixture.detailStatus.resource=-1;resumeFixture.holdDetail.resource=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())'); await failed();
      ensure(await evaluate('document.activeElement==='+retry+' && document.querySelector(".book-detail-page h1").textContent==="续读回归用书" && resumeFixture.editorRequests.filter(r=>r.operation==="'+operation+'").length===1'), label + ' disconnected refresh preserves confirmation and restores its GET-only retry');
      await evaluate('resumeFixture.detailStatus.resource=0;resumeFixture.holdDetail.progress=true'); await click(retry); await wait('resumeFixture.pendingDetails.some(r=>r.operation==="progress")');
      ensure(await evaluate(catalogLinks+'.length===0 && document.querySelector(".book-detail-page h1").textContent==="续读回归用书"'), label + ' catalogue and progress cannot publish as partial editions');
      await evaluate('resumeFixture.holdDetail.progress=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())'); await wait('!'+recovery+' && '+catalogLinks+'.length>0');
      await wait('document.activeElement==='+catalogLinks+'[0]');
      const expected = operation === 'append' ? 4 : operation === 'remove' ? 2 : 3;
      ensure(await evaluate(catalogLinks+'.length==='+expected+' && document.querySelector(".book-detail-page h1").textContent==="已更新的目录版本" && document.querySelectorAll(".book-detail-catalog-content button[aria-label^=编辑]").length==='+expected+' && document.activeElement==='+catalogLinks+'[0] && resumeFixture.editorRequests.filter(r=>r.operation==="'+operation+'").length===1'), label + ' successful retry publishes one coherent catalogue without replaying the write');
      ensure(await evaluate('document.documentElement.scrollWidth<=innerWidth+1 && !'+append+'.disabled && '+(operation === 'remove' ? '!document.querySelector(".book-detail-catalog-content").textContent.includes("第2话") && document.querySelector(".book-detail-catalog-content").textContent.includes("第3话")' : operation === 'save' ? 'document.querySelector(".book-detail-catalog-content").textContent.includes("第2话·修订")' : 'document.querySelector(".book-detail-page").textContent.includes("阅读新增章节")')), label + ' recovered chapter titles and actions fit the viewport');
    }
    for (const change of ['route', 'account']) {
      await open(); await startMutation('save'); await evaluate('resumeFixture.holdDetail.resource=true'); await releaseMutation('save');
      await wait('resumeFixture.pendingDetails.some(r=>r.operation==="resource")');
      if (change === 'route') { await evaluate('fixtureNavigate("/public?q=test")'); await wait('!!document.querySelector("#collection-return")'); }
      else {
        await evaluate('resumeFixture.book.title="新账号的书";resumeFixture.resource.toc[0].title="新账号目录";resumeFixture.holdDetail.resource=false;resumeFixture.switchAccount("mutation-next-user")'); await detailReady();
      }
      await evaluate('resumeFixture.holdDetail.resource=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())'); await sleep(200);
      ensure(await evaluate('!'+recovery+' && resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1 && resumeFixture.detailReads.filter(r=>r.operation==="resource").some(r=>r.signal.aborted) && '+(change === 'route' ? '!!document.querySelector("#collection-return") && !document.querySelector(".book-detail-page")' : 'document.querySelector(".book-detail-page h1").textContent==="新账号的书" && document.querySelector(".book-detail-catalog-content").textContent.includes("新账号目录") && !document.querySelector("[role=dialog]")')), change + ' change aborts confirmed-write refresh and ignores late responses');
    }
    await open(); await startMutation('save'); await evaluate('resumeFixture.holdDetail.resource=true'); await releaseMutation('save'); await wait('resumeFixture.pendingDetails.some(r=>r.operation==="resource")');
    const favorite = 'Array.from(document.querySelectorAll(".book-detail-actions button")).find(e=>e.textContent.includes("加入收藏"))';
    await scrollTo(favorite); await click(favorite); await evaluate('resumeFixture.holdDetail.resource=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())'); await failed(false);
    ensure(await evaluate(recovery+'.textContent.includes("已将") && resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1'), 'a newer local action invalidates a pending catalogue snapshot without losing the confirmed chapter outcome');
    await open();
    await evaluate('resumeFixture.holdDetail.progress=true');
    // A new initial read is held before mutation; its response captures the old position.
    await evaluate('fixtureNavigate("/library")'); await wait('!!document.querySelector("#collection-return")');
    await evaluate('fixtureNavigate("/books/resume-test")'); await wait('!!document.querySelector(".book-detail-page h1") && '+catalogLinks+'.length===3 && resumeFixture.pendingDetails.some(r=>r.operation==="progress")');
    await evaluate('resumeFixture.preEditProgressRequest=resumeFixture.detailReads.filter(r=>r.operation==="progress").at(-1);Object.assign(resumeFixture.progress(),{progress_percent:65,chapter_index:2,epub_cfi:"aisu-scroll:0.95",updated_at:new Date().toISOString()})');
    // Aborted background reads can remain queued by the fake transport. Release
    // the live refresh request, independently of how many cancelled reads remain.
    await startMutation('save'); await releaseMutation('save'); await wait('resumeFixture.pendingDetails.some(r=>r.operation==="progress" && !r.signal?.aborted)');
    await evaluate('(()=>{const index=resumeFixture.pendingDetails.findIndex(r=>r.operation==="progress" && !r.signal?.aborted);resumeFixture.pendingDetails.splice(index,1)[0].resolve()})()'); await wait('!'+recovery+' && document.querySelector(".book-detail-progress [role=progressbar]")?.getAttribute("aria-valuenow")==="65"');
    await evaluate('resumeFixture.holdDetail.progress=false;resumeFixture.pendingDetails.splice(0).forEach(r=>r.resolve())'); await sleep(200);
    ensure(await evaluate('document.querySelector(".book-detail-progress [role=progressbar]").getAttribute("aria-valuenow")==="65" && resumeFixture.preEditProgressRequest.signal.aborted && resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1'), 'a late pre-edit progress read cannot replace the coherently refreshed position');
    for (const operation of ['append', 'save', 'remove']) {
      await open(); await startMutation(operation); await evaluate('resumeFixture.editorStatus.'+operation+'=-1'); await releaseMutation(operation);
      await wait('document.querySelector("[role=dialog] [role=alert]")?.textContent.includes("结果未确认")');
      ensure(await evaluate('document.querySelector("[role=dialog] textarea").value.length>0 && !'+recovery+' && resumeFixture.editorRequests.filter(r=>r.operation==="'+operation+'").length===1'), operation + ' unconfirmed transport result retains the chapter draft and asks for verification');
    }
  }
  if (chromeOnly || (!detailOnly && !detailMutationOnly && !detailProgressOnly && !startupOnly && !boundaryOnly && !mediaOnly && !raceOnly && !marksOnly && !editorOnly && !process.env.READER_TEST_WIDTH && !process.env.READER_TEST_MODE)) {
    await verifyChromePaint({ command, ensure, evaluate, fresh, readAt, screenshot, sleep });
    const tapReader = async () => {
      const point = await evaluate(`(()=>{
        const left=visualViewport?.offsetLeft||0,top=visualViewport?.offsetTop||0,width=visualViewport?.width||innerWidth,height=visualViewport?.height||innerHeight;
        const player=document.querySelector('[aria-label=听书播放器]');
        if(!player)return {x:left+width/2,y:top+height/2};
        // In short windows the player covers the centre. Tap exposed prose,
        // just as a reader would, rather than a playback control.
        const bounds=player.getBoundingClientRect(),shell=document.querySelector('.reader-viewport');
        for(const y of [bounds.bottom+6,bounds.top-6,top+height/2])for(const ratio of [.5,.35,.65,.15,.85]){
          const x=left+width*ratio,target=document.elementFromPoint(x,y);
          if(y>top&&y<top+height&&target&&shell.contains(target)&&!target.closest('a,button,input,select,textarea'))return {x,y};
        }
        throw Error('No exposed reader area to toggle controls');
      })()`);
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    };
    const chromeSnapshot = `(()=>{const root=document.querySelector('.reader-with-reading-status'),shell=document.querySelector('.reader-viewport'),bar=document.querySelector('.reader-bottom-bar'),track=document.querySelector('.reader-scroll-position'),thumb=track?.firstElementChild,header=document.querySelector('.reader-chrome-top'),rect=e=>{if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}},style=getComputedStyle(bar);return {visible:!bar.inert,opacity:Number(style.opacity),paint:style.visibility,scroll:${scroller}.scrollTop,viewport:rect(shell),track:rect(track),thumb:rect(thumb),header:rect(header),bar:rect(bar),clip:shell.style.clipPath,layoutTop:getComputedStyle(root).getPropertyValue('--reader-layout-top-inset'),layoutBottom:getComputedStyle(root).getPropertyValue('--reader-layout-bottom-inset')}})()`;
    for (const [width, height, touch, paged, theme, zoom] of [
      [390, 844, true, false, 'dark', 1], [390, 844, true, true, 'white', 1],
      [768, 1024, true, false, 'paper', 1], [768, 1024, true, true, 'green', 1],
      [1536, 864, false, false, 'dark', 1], [1536, 864, false, true, 'paper', 1],
      [1536, 864, false, false, 'dark', 1.5], [1536, 864, false, true, 'white', 1.5],
    ]) {
      await command('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await fresh(width, height, touch, 'theme=' + theme + (paged ? '&paged' : '')); await readAt(4000);
      if (zoom !== 1) { await command('Emulation.setPageScaleFactor', { pageScaleFactor: zoom }); await sleep(250); }
      const label = width + ' ' + (paged ? 'paged' : 'scroll') + ' ' + theme + ' zoom ' + zoom;
      const before = await evaluate(chromeSnapshot);
      await evaluate('window.chromeSamples=[];window.chromeSamplesDone=new Promise(resolve=>{const start=performance.now();const sample=()=>{chromeSamples.push('+chromeSnapshot+');if(performance.now()-start<650)requestAnimationFrame(sample);else resolve(chromeSamples)};sample()});true');
      await tapReader(); await sleep(90); await tapReader(); await sleep(35); await tapReader();
      const samples = await evaluate('chromeSamplesDone');
      ensure(samples.some(s=>s.visible) && samples.some(s=>!s.visible) && samples.every(s=>s.clip==='' && s.opacity>=0 && s.opacity<=1), label + ' rapid show and hide leaves prose painting intact throughout the fade', samples.slice(0, 3));
      ensure(samples.every(s=>Math.abs(s.scroll-before.scroll)<=2 && Math.abs(s.viewport.top-before.viewport.top)<=1 && Math.abs(s.viewport.bottom-before.viewport.bottom)<=1 && s.layoutTop===before.layoutTop && s.layoutBottom===before.layoutBottom), label + ' toggling controls preserves the text position and reading viewport');
      if (before.track) ensure(samples.every(s=>s.track && s.thumb && Math.abs(s.track.top-before.track.top)<=1 && Math.abs(s.track.bottom-before.track.bottom)<=1 && Math.abs(s.thumb.top-before.thumb.top)<=1), label + ' scrubber track and thumb stay fixed throughout the toggle', { before, last:samples.at(-1) });
      else ensure(samples.every(s=>s.track===null), label + (touch ? ' touch reading keeps native edge scrolling' : ' paged reading has no vertical scrubber'));
      await screenshot('reader-chrome-' + width + '-' + (paged?'paged':'scroll') + '-' + zoom);
      await sleep(3350); const hidden = await evaluate(chromeSnapshot);
      ensure(!hidden.visible && hidden.paint==='hidden' && Math.abs(hidden.scroll-before.scroll)<=2 && hidden.viewport.bottom===before.viewport.bottom && (!before.thumb || Math.abs(hidden.thumb.top-before.thumb.top)<=1), label + ' automatic dismissal releases controls without moving text or the scrubber');
    }
    const touchTap = async (point) => {
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(150);
    };
    // A touchend reveals the bar before the browser sends its compatibility
    // click. Start from the visible reading surface, then exercise the button
    // after the bar is shown. Fine-pointer cases model a touch laptop.
    for (const [width, height, touch, paged] of [
      [390, 844, true, false], [768, 1024, true, false],
      [1536, 864, false, false], [1536, 864, false, true],
    ]) {
      await command('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await fresh(width, height, touch, 'theme=dark&silentAudiobook' + (paged ? '&paged' : ''));
      if (!paged) await readAt(4000);
      const points = await evaluate(`(()=>{
        const shell=document.querySelector('.reader-viewport'), button=document.querySelector('.reader-bottom-bar [aria-label="打开当前章查找"]');
        const buttonRect=button.getBoundingClientRect();
        const y=innerHeight/2;
        return { reveal:{x:innerWidth/2,y}, tool:{x:buttonRect.x+buttonRect.width/2,y:buttonRect.y+buttonRect.height/2}, inside:shell.contains(document.elementFromPoint(innerWidth/2,y)) };
      })()`);
      const point = points.reveal;
      const label = width + ' ' + (touch ? 'touch' : 'hybrid') + ' ' + (paged ? 'paged' : 'scroll');
      ensure(points.inside && await evaluate('document.querySelector(".reader-bottom-bar").inert'), label + ' reveal tap starts on exposed prose within the reading surface');
      const before = await evaluate(chromeSnapshot);
      const preferences = await evaluate('localStorage.getItem("aisu-bookhouse:reader-preferences")');
      await touchTap(point);
      const revealed = await evaluate(chromeSnapshot);
      ensure(revealed.visible && !await evaluate(`!!document.querySelector('.reader-find-bar, [role="dialog"], [aria-label="听书播放器"]')`) && preferences === await evaluate('localStorage.getItem("aisu-bookhouse:reader-preferences")'), label + ' revealing controls never clicks through into a newly shown tool');
      ensure(Math.abs(revealed.scroll-before.scroll)<=1 && revealed.viewport.top===before.viewport.top && revealed.viewport.bottom===before.viewport.bottom && (!before.thumb || Math.abs(revealed.thumb.top-before.thumb.top)<=1), label + ' a real touch reveal preserves prose and the right progress thumb');
      await screenshot('reader-touch-reveal-' + width + '-' + (paged ? 'paged' : 'scroll'));
      await touchTap(points.tool);
      await wait('!!document.querySelector(".reader-find-bar")');
      ensure(true, label + ' a separate immediate tap still opens the intended tool');
      await click('document.querySelector("[aria-label=关闭查找]")');
      await wait('!document.querySelector(".reader-find-bar")');
      if (await evaluate('!document.querySelector(".reader-bottom-bar").inert')) await touchTap({ x: width / 2, y: height / 2 });
      const originTop = await evaluate(`${scroller}.scrollTop`);
      await touchTap({ x: width * .85, y: height / 2 });
      const firstTop = await evaluate(`${scroller}.scrollTop`);
      await touchTap({ x: width * .85, y: height / 2 });
      const secondTop = await evaluate(`${scroller}.scrollTop`);
      const pageHeight = await evaluate(`${scroller}.clientHeight`);
      ensure(firstTop > originTop && secondTop > firstTop && firstTop-originTop <= pageHeight && secondTop-firstTop <= pageHeight, label + ' consecutive side taps each advance one screen without duplicate clicks');
      await touchTap({ x: width * .15, y: height / 2 });
      await touchTap({ x: width * .15, y: height / 2 });
      ensure(Math.abs(await evaluate(`${scroller}.scrollTop`)-originTop)<=2, label + ' consecutive reverse taps return to the original text');
    }
    const playerSnapshot = `(()=>{const root=document.querySelector('.reader-with-reading-status'),shell=${scroller},player=document.querySelector('[aria-label=听书播放器]'),thumb=document.querySelector('.reader-scroll-position-thumb');return {visible:!document.querySelector('.reader-bottom-bar').inert,scroll:shell.scrollTop,height:shell.scrollHeight,tail:root.style.getPropertyValue('--reader-audiobook-tail-space'),playerTop:player.getBoundingClientRect().top,reservedTop:player.dataset.readerPlayerReservedTop,thumb:thumb?.getClientRects().length?thumb.getBoundingClientRect().top:null,lastLine:document.querySelector('.reader-body-text').getBoundingClientRect().bottom}})()`;
    for (const [width, height, touch, theme, zoom] of [
      [390, 844, true, 'dark', 1], [768, 1024, true, 'paper', 1],
      [1536, 864, false, 'dark', 1], [1536, 430, false, 'white', 1],
      [1536, 864, false, 'green', 1.5],
    ]) {
      await command('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await fresh(width, height, touch, 'silentAudiobook&theme=' + theme);
      await reveal('[aria-label=打开听书]'); await click('document.querySelector("[aria-label=打开听书]")');
      await wait('!!document.querySelector("[aria-label=听书播放器]") && document.body.innerText.includes("设备语音暂时无法播放")');
      await readAt(4000);
      if (zoom !== 1) { await command('Emulation.setPageScaleFactor', { pageScaleFactor: zoom }); await sleep(250); }
      const label = width + 'x' + height + ' audiobook ' + theme + ' zoom ' + zoom;
      const before = await evaluate(playerSnapshot);
      await evaluate('window.playerSamples=[];window.playerSamplesDone=new Promise(resolve=>{const start=performance.now();const sample=()=>{playerSamples.push('+playerSnapshot+');if(performance.now()-start<750)requestAnimationFrame(sample);else resolve(playerSamples)};sample()});true');
      await tapReader(); await sleep(90); await tapReader(); await sleep(35); await tapReader();
      const samples = await evaluate('playerSamplesDone');
      ensure(samples.some(s=>s.visible) && samples.some(s=>!s.visible), label + ' controls toggle while the real player stays open');
      ensure(samples.every(s=>Math.abs(s.scroll-before.scroll)<=1 && Math.abs(s.height-before.height)<=1 && s.tail===before.tail && s.reservedTop===before.reservedTop), label + ' player avoidance preserves chapter height and text position', { before, samples });
      ensure(samples.every(s=>s.thumb===null ? before.thumb===null : Math.abs(s.thumb-before.thumb)<=1), label + ' player avoidance never moves the right progress thumb', { before, samples });
      await readAt(1e7, 250);
      const end = await evaluate(playerSnapshot);
      await tapReader(); await sleep(250); const toggledEnd = await evaluate(playerSnapshot);
      ensure(Math.abs(end.scroll-toggledEnd.scroll)<=1 && Math.abs(end.height-toggledEnd.height)<=1 && end.lastLine<=end.playerTop-11 && toggledEnd.lastLine<=toggledEnd.playerTop-11, label + ' final line stays readable without snapping at chapter end', { end, toggledEnd });
      await screenshot('reader-audiobook-chrome-' + width + '-' + height + '-' + zoom);
      await reveal('[aria-label=关闭听书]'); await click('document.querySelector("[aria-label=关闭听书]")');
      await wait('!document.querySelector("[aria-label=听书播放器]") && document.querySelector(".reader-with-reading-status").style.getPropertyValue("--reader-audiobook-tail-space")==="0px"');
      ensure(await evaluate('!document.querySelector("[aria-label=听书播放器]")'), label + ' closing the player releases its reserved chapter tail');
    }
    await command('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  }
  }
  ensure(errors.length === 0, 'no uncaught browser errors', errors);
  ensure(consoleErrors.length === 0 && forwardedConsoleErrors.length === 0, 'no browser console errors', [...consoleErrors, ...forwardedConsoleErrors].slice(0, 1));
  fs.writeFileSync(path.join(reportDir, chapterHistoryOnly ? 'chapter-history-results.json' : chapterUpdatesOnly ? 'chapter-update-results.json' : markUpdatesOnly ? 'mark-update-results.json' : markPositionsOnly ? 'mark-position-results.json' : chapterEditPositionsOnly ? 'chapter-edit-position-results.json' : chapterProgressOnly ? 'chapter-progress-results.json' : appendedProgressOnly ? 'appended-progress-results.json' : translationReviewOnly ? 'translation-review-results.json' : bookActionsOnly ? 'book-action-results.json' : bookDialogsOnly ? 'book-dialog-results.json' : pdfControlsOnly ? 'pdf-controls-results.json' : imageControlsOnly ? 'image-controls-results.json' : catalogOnly ? 'catalog-results.json' : navigationUiOnly ? 'navigation-ui-results.json' : preferenceLayoutOnly ? 'preference-layout-results.json' : preferencesOnly ? 'preference-results.json' : editorInteractionOnly ? 'editor-interaction-results.json' : chapterDraftOnly ? 'chapter-draft-results.json' : mutationRetryOnly ? 'mutation-retry-results.json' : detailProgressOnly ? 'detail-progress-results.json' : detailMutationOnly ? 'detail-mutation-results.json' : chromeOnly ? 'chrome-results.json' : detailOnly ? 'book-detail-results.json' : editorRecoveryOnly ? 'editor-recovery-results.json' : editorOnly ? 'editor-results.json' : marksOnly ? 'marks-results.json' : raceOnly ? 'race-results.json' : mediaOnly ? 'media-results.json' : boundaryOnly ? 'boundary-results.json' : startupOnly ? 'startup-results.json' : 'results.json'), JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  console.log('FAILURE', String(error));
  console.log(JSON.stringify({errors, state:await evaluate('({text:document.body.innerText.slice(0,3000),url:location.href,fixture:typeof resumeFixture})')}).slice(0,12000));
  if(await evaluate('typeof resumeFixture!=="undefined"')) console.log(JSON.stringify(await state()).slice(0, 12000));
  if (detailOnly || detailMutationOnly || detailProgressOnly || await evaluate('!!document.querySelector(".book-detail-page")')) console.log('DETAIL_DIAGNOSTICS ' + JSON.stringify(await evaluate('({pending:resumeFixture.pendingDetails.map(r=>({operation:r.operation,aborted:r.signal?.aborted})),reads:resumeFixture.detailReads.map(r=>({operation:r.operation,scope:r.scope,aborted:r.signal?.aborted}))})')));
  const shot = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(reportDir, 'failure.png'), Buffer.from(shot.data, 'base64'));
  throw error;
} finally {
  try { await Promise.race([command('Browser.close'), sleep(2000)]); } catch { child.kill(); }
  // Chromium can still hold profile files after acknowledging Browser.close.
  await Promise.race([childExited, sleep(4000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([childExited, sleep(2000)]);
  }
  socket.close();
  await vite.close();
  // Delete only the temporary profile created above, after Chromium exits.
  await sleep(500);
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('aisu-reader-resume-')) {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}
