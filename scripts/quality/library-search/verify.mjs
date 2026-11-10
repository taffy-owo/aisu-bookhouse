import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verifyPaginationFeedback } from './pagination-cases.mjs';
import { verifySeriesContinuity } from './series-cases.mjs';
import { verifyHomeShelf } from './home-shelf-cases.mjs';
import { verifyHeaderControls } from './header-control-cases.mjs';
import { verifyMobileShell } from './mobile-shell-cases.mjs';
import { verifyBulkShelf } from './bulk-shelf-cases.mjs';
import { verifyJapaneseShelfContinuity } from './japanese-shelf-cases.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const reportDir = path.join(root, 'tmp/library-search-results');
fs.mkdirSync(reportDir, { recursive: true });
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
if (!executable) throw Error('Set CHROME_PATH to a Chromium executable');
const vite = await createServer({ root, cacheDir: path.join(reportDir, '.vite', String(process.pid)), optimizeDeps: { entries: ['scripts/quality/library-search/fixture.html'] }, server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aisu-library-search-'));
const browser = spawn(executable, ['--headless', '--no-first-run', '--disable-background-networking', '--user-data-dir=' + profile, '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let browserExited = false;
const browserExit = new Promise(resolve => browser.once('exit', () => { browserExited = true; resolve(); }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let closeBrowser = async () => { browser.kill(); };
let diagnostics = async () => ({});
const checks = [], errors = [];
const paginationOnly = process.argv.includes('--pagination');
const bulkOnly = process.argv.includes('--bulk');
const seriesOnly = process.argv.includes('--series');
const homeOnly = process.argv.includes('--home-shelf');
const headerOnly = process.argv.includes('--header-controls');
const mobileShellOnly = process.argv.includes('--mobile-shell');
const japaneseOnly = process.argv.includes('--japanese-shelf');
try {
  let tabs;
  for (let i = 0; i < 60; i++) { try { tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); break; } catch { await sleep(100); } }
  if (!tabs) throw Error('Browser startup failed');
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => { const r = JSON.parse(data), p = pending.get(r.id); if (r.method === 'Runtime.exceptionThrown') errors.push(r.params); if (r.method === 'Runtime.consoleAPICalled' && r.params.type === 'error') errors.push(r.params); if (p) { pending.delete(r.id); r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result); } };
  const command = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method, params })); });
  closeBrowser = () => command('Browser.close');
  const evaluate = async expression => { const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  diagnostics = () => evaluate('({url:location.href,footer:document.querySelector("[data-shelf-footer]")?.textContent,active:document.activeElement?.outerHTML.slice(0,300),pages:document.querySelector("[data-navigation-pages]")?.dataset.navigationPages,requests:window.searchFixture?.requests})');
  const wait = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await sleep(100); } throw Error('Timeout ' + expression + ' ' + await evaluate('document.body.innerText.slice(0,800)')); };
  const ensure = (condition, label, detail) => { if (!condition) throw Error(label + ' ' + JSON.stringify(detail)); checks.push(label); console.log('PASS ' + label); };
  const input = 'document.querySelector("[aria-label=搜索书名、作者]")';
  const fill = async text => { await evaluate(`${input}.focus({preventScroll:true});${input}.select()`); await command('Input.insertText', { text }); };
  const click = async expression => { const point = await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing click target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await sleep(150); };
  const enter = async () => { await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(200); };
  const submit = async text => { await fill(text); await enter(); };
  const ready = async q => wait(`window.searchFixture?.location?.pathname===location.pathname && !!document.querySelector('[data-book-id]') && document.querySelector('[data-navigation-loading]')?.dataset.navigationLoading==='false' && document.querySelector('[data-book-id]').textContent.includes(${JSON.stringify(q)})`);
  const navigate = async pathname => {
    await evaluate(`searchFixture.navigate(${JSON.stringify(pathname)})`);
    // history updates before React commits the route. Wait for the outlet,
    // then let the frame finish before sending input to the shared header.
    await wait(`searchFixture.location.pathname===${JSON.stringify(pathname)} && ${pathname==='/settings'?"!!document.querySelector('[data-search-settings]')":"!document.querySelector('[data-search-settings]')"}`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))');
  };
  await command('Page.enable'); await command('Runtime.enable'); await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (japaneseOnly) {
    await verifyJapaneseShelfContinuity({ command, evaluate, wait, ensure, click, sleep, origin });
  } else if (bulkOnly) {
    await verifyBulkShelf({ command, evaluate, wait, ensure, click, sleep, origin, reportDir, baseline: process.argv.includes('--baseline') });
  } else if (mobileShellOnly) {
    await verifyMobileShell({ command, evaluate, wait, ensure, click, sleep, origin, reportDir, baseline: process.argv.includes('--baseline') });
  } else if (headerOnly) {
    await verifyHeaderControls({ command, evaluate, wait, ensure, click, sleep, origin, reportDir, baseline: process.argv.includes('--baseline') });
  } else if (homeOnly) {
    await verifyHomeShelf({ command, evaluate, wait, ensure, click, sleep, origin, reportDir, baseline: process.argv.includes('--baseline') });
  } else if (seriesOnly) {
    await verifySeriesContinuity({ command, evaluate, wait, ensure, click, sleep, origin, reportDir });
  } else if (paginationOnly) {
    await verifyPaginationFeedback({ command, evaluate, wait, ensure, click, sleep, origin });
  } else {
  for (const [width, height, touch] of [[1536, 864, false], [390, 844, true], [1024, 768, true]]) for (const route of ['/library', '/public']) {
    await command('Page.navigate', { url: 'about:blank' });
    await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
    await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await command('Page.navigate', { url: origin + '/scripts/quality/library-search/fixture.html?page=' + route });
    await ready('全部');
    const label = width + ' ' + route;
    if (route === '/library' && touch) ensure(await evaluate(`Array.from(document.querySelectorAll('.library-filters button,.library-filters select')).every(e=>{const r=e.getBoundingClientRect();return r.height>=44&&r.width>=44})`), label + ' touch filters retain 44px targets');
    await submit('第一次搜索'); await ready('第一次搜索');
    await submit('第二次搜索'); await ready('第二次搜索');
    await evaluate('window.scrollTo({top:1200,behavior:"instant"})'); await sleep(200);
    const before = await evaluate('({key:searchFixture.location.key,y:scrollY,entries:searchFixture.locations.length,requests:searchFixture.requests.length})');
    await submit('  第二次搜索  ');
    const after = await evaluate('({key:searchFixture.location.key,y:scrollY,entries:searchFixture.locations.length,requests:searchFixture.requests.length})');
    ensure(before.key === after.key && before.entries === after.entries, label + ' repeating a trimmed query does not add browser history', { before, after });
    ensure(Math.abs(before.y-after.y)<=1 && before.requests===after.requests, label + ' repeat submission preserves the result position and request');
    ensure(await evaluate(`${input}.value==='第二次搜索'`), label + ' repeat submission trims the visible input');
    if (touch) ensure(await evaluate(`document.activeElement!==${input}`), label + ' repeat submission dismisses the touch keyboard');
    await evaluate('history.back()'); await ready('第一次搜索');
    ensure(await evaluate(`${input}.value==='第一次搜索'`), label + ' one Back returns to the preceding distinct query');
    await fill('候选字');
    const priorKey = await evaluate('searchFixture.location.key');
    await evaluate(`${input}.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true}))`); await sleep(120);
    ensure(await evaluate('searchFixture.location.key') === priorKey, label + ' IME confirmation does not submit a query');
    await evaluate('searchFixture.held.add("慢查询")'); await submit('慢查询');
    await wait('searchFixture.requests.some(r=>r.q==="慢查询")');
    await fill('新查询'); await evaluate('document.querySelector("form[aria-label=全站搜索]").requestSubmit()'); await ready('新查询');
    const newKey = await evaluate('searchFixture.location.key');
    await evaluate('searchFixture.pending.splice(0).forEach(resolve=>resolve());searchFixture.held.clear()'); await sleep(200);
    ensure(await evaluate('document.querySelector("[data-book-id]").textContent.includes("新查询")'), label + ' late responses cannot overwrite a newer query');
    await fill(' 新查询 '); await evaluate('document.querySelector("form[aria-label=全站搜索]").requestSubmit()'); await sleep(200);
    ensure(await evaluate('searchFixture.location.key') === newKey, label + ' native form resubmission also preserves the history entry');
    if (touch) ensure(await evaluate(`document.activeElement!==${input}`), label + ' native form submission dismisses the touch keyboard');
    await click('document.querySelector("[aria-label=清除搜索]")'); await ready('全部');
    ensure(await evaluate(`(()=>{const p=new URLSearchParams(location.search);return !p.has('q')&&p.get('kind')==='novel'&&p.get('sort')==='title'&&p.get('view')==='list'&&document.activeElement===${input}})()`), label + ' clearing preserves filters and input focus');
    const clearKey = await evaluate('searchFixture.location.key'); await submit('   ');
    ensure(await evaluate('searchFixture.location.key') === clearKey, label + ' repeated empty submission does not add browser history');
    await evaluate('searchFixture.empty=true'); await submit('没有结果'); await wait('document.body.innerText.includes("没有找到")');
    ensure(await evaluate(`Array.from(document.querySelectorAll('.app-content button')).some(e=>/^查看全部/.test(e.textContent)) && document.documentElement.scrollWidth<=innerWidth`), label + ' empty results fit the viewport and offer recovery');
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(reportDir, width + '-' + route.slice(1) + '.png'), Buffer.from(screenshot.data, 'base64'));
    await evaluate('searchFixture.empty=false');
    await click(`Array.from(document.querySelectorAll('.app-content button')).find(e=>/^查看全部/.test(e.textContent))`); await ready('全部');
    ensure(await evaluate(`(()=>{const p=new URLSearchParams(location.search);return !p.has('q')&&!p.has('kind')&&p.get('sort')==='title'&&p.get('view')==='list'})()`), label + ' empty-state recovery clears query and category while preserving sort and view');
    await navigate('/settings'); await wait(`${input}.value===''`);
    await fill('未提交草稿'); await navigate(route); await ready('全部');
    ensure(await evaluate(`${input}.value===''`), label + ' leaving an unsubmitted search clears it on another page');
    await navigate('/settings'); await wait(`${input}.value===''`);
    await submit('全站入口'); await ready('全站入口');
    ensure(await evaluate(`location.pathname==='/library'&&new URLSearchParams(location.search).get('q')==='全站入口'&&!new URLSearchParams(location.search).has('kind')`), label + ' searches outside a collection open a fresh library query');
  }
  }
  ensure(errors.length === 0, 'no browser runtime or console errors', errors);
  fs.writeFileSync(path.join(reportDir, japaneseOnly ? 'japanese-shelf-results.json' : bulkOnly ? 'bulk-shelf-results.json' : mobileShellOnly ? 'mobile-shell-results.json' : headerOnly ? 'header-controls-results.json' : homeOnly ? 'home-shelf-results.json' : seriesOnly ? 'series-results.json' : paginationOnly ? 'pagination-results.json' : 'results.json'), JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  console.error('LIBRARY_SEARCH_FAILURE', String(error));
  try { console.error('DIAGNOSTICS', JSON.stringify(await diagnostics())); } catch { /* Preserve the original failure if the page is unavailable. */ }
  throw error;
} finally {
  await Promise.race([closeBrowser().catch(() => {}), sleep(2000)]);
  await Promise.race([browserExit, sleep(2000)]);
  if (!browserExited) { browser.kill(); await Promise.race([browserExit, sleep(2000)]); }
  socket?.close(); await vite.close();
  if (browserExited && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('aisu-library-search-')) {
    try { await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { console.warn('Temporary browser profile retained after cleanup:', profile, error.code); }
  }
}
