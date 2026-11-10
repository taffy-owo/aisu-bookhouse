import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verifyAccountForms } from './account-cases.mjs';
import { verifyInvitations } from './invitation-cases.mjs';
import { verifyAnalytics } from './analytics-cases.mjs';
import { verifyCalendarWeeks } from './calendar-week-cases.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const reportDir = path.join(root, 'tmp/profile-account-results');
fs.mkdirSync(reportDir, { recursive: true });
const probeOnly = process.argv.includes('--probe');
const invitationProbe = process.argv.includes('--invitation-probe');
const invitationOnly = process.argv.includes('--invitations') || invitationProbe;
const calendarOnly = process.argv.includes('--calendar-week');
const analyticsOnly = process.argv.includes('--analytics') || calendarOnly;
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
if (!executable) throw Error('Set CHROME_PATH to a Chromium executable');
const vite = await createServer({ root, cacheDir: path.join(reportDir, '.vite', String(process.pid)), optimizeDeps: { entries: ['scripts/quality/profile-account/fixture.html'] }, server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aisu-profile-account-'));
const browser = spawn(executable, ['--headless', '--no-first-run', '--disable-background-networking', '--user-data-dir=' + profile, '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let browserExited = false;
const browserExit = new Promise(resolve => browser.once('exit', () => { browserExited = true; resolve(); }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, closeBrowser = async () => { browser.kill(); };
const checks = [], errors = [], observations = [];
try {
  let tabs;
  for (let n = 0; n < 80; n++) { try { tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); break; } catch { await sleep(100); } }
  if (!tabs) throw Error('Chromium did not start');
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0; const calls = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data), pending = calls.get(message.id); if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message); if (pending) { calls.delete(message.id); message.error ? pending.reject(Error(JSON.stringify(message.error))) : pending.resolve(message.result); } };
  socket.onclose = () => { for (const pending of calls.values()) pending.reject(Error('Browser closed')); calls.clear(); };
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; calls.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  closeBrowser = () => command('Browser.close');
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(expression + ' ' + JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const wait = async expression => { for (let n = 0; n < 150; n++) { if (await evaluate(expression)) return; await sleep(80); } throw Error('Timeout ' + expression + ' ' + await evaluate('document.body.innerText.slice(-1600)')); };
  const ensure = (value, label, detail) => { if (!value) throw Error(label + ' ' + JSON.stringify(detail)); checks.push(label); console.log('PASS ' + label); };
  const input = async (selector, value) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(40); };
  const click = async expression => { const point = await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing click target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded target '+e.textContent);return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await sleep(100); };
  const fresh = async (width = 1536, height = 864, touch = false, dark = false, font = 16, query = '') => {
    await command('Page.navigate', { url: 'about:blank' }); await wait('location.href==="about:blank"');
    await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
    await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await command('Page.navigate', { url: origin + '/scripts/quality/profile-account/fixture.html?' + query + (dark ? '&dark' : '') });
    await wait('!!document.querySelector(".profile-page") && !!accountFixture.navigate');
    await evaluate(`document.documentElement.style.fontSize='${font}px';sessionStorage.clear()`);
    if (width < 1280) await click(`document.querySelector('[aria-label=个人中心分类] button:${analyticsOnly ? 'first' : 'last'}-child')`);
  };
  const openNickname = async () => { await click('document.querySelector("button[aria-label=修改昵称]")'); await wait('!!document.querySelector("input[aria-label=昵称]")'); await input('input[aria-label=昵称]', '新的昵称'); };
  const openPassword = async () => { await click('Array.from(document.querySelectorAll(".profile-account-section button")).find(e=>e.textContent.trim()==="修改密码")'); await wait('!!document.querySelector("input[aria-label=当前密码]")'); for (const [label, value] of [['当前密码', 'old-password'], ['新密码', 'new-password'], ['确认新密码', 'new-password']]) await input('input[aria-label=' + label + ']', value); };
  const submitTwice = async operation => evaluate(`(()=>{const f=document.querySelector('form[aria-label=${operation === 'nickname' ? '修改昵称' : '修改密码'}]');f.requestSubmit();f.requestSubmit()})()`);
  const shot = async name => { const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(reportDir, name + '.png'), Buffer.from(result.data, 'base64')); };
  await command('Page.enable'); await command('Runtime.enable'); await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (calendarOnly) await verifyCalendarWeeks({ command, evaluate, wait, ensure, click, fresh, sleep, shot, observations });
  else if (analyticsOnly) await verifyAnalytics({ command, evaluate, wait, ensure, click, fresh, sleep, shot, observations });
  else if (invitationOnly) await verifyInvitations({ command, evaluate, wait, ensure, input, click, fresh, sleep, shot, probeOnly: invitationProbe, observations });
  else if (!probeOnly) await verifyAccountForms({ command, evaluate, wait, ensure, input, click, fresh, openNickname, openPassword, submitTwice, sleep, shot });
  else {
  for (const operation of ['nickname', 'password']) {
    await fresh(320, 640, true); await (operation === 'nickname' ? openNickname() : openPassword());
    await evaluate(`accountFixture.fail=true;accountFixture.error='连接返回了较长的错误：'+('upstream_error_request_'.repeat(24))`);
    await submitTwice(operation); await wait('accountFixture.requests.length>0');
    const count = await evaluate('accountFixture.requests.length');
    observations.push({ operation, requests: count });
    if (!probeOnly) ensure(count === 1, operation + ' same-turn duplicate submits send one write', { count });
    await evaluate('accountFixture.release()');
    await wait('!!document.querySelector(".profile-account-section [role=alert]")');
    const geometry = await evaluate(`(()=>{const e=document.querySelector('.profile-account-section [role=alert]');return{width:e.clientWidth,scrollWidth:e.scrollWidth,viewport:innerWidth,page:document.documentElement.scrollWidth}})()`);
    observations.at(-1).error = geometry;
    if (!probeOnly) ensure(geometry.scrollWidth <= geometry.width + 1 && geometry.page <= geometry.viewport, operation + ' long failure messages fit narrow screens', geometry);
  }
  }
  console.log('OBSERVATIONS ' + JSON.stringify(observations));
  ensure(errors.length === 0, 'no browser runtime or console errors', errors);
  fs.writeFileSync(path.join(reportDir, calendarOnly ? 'calendar-week-results.json' : analyticsOnly ? 'analytics-results.json' : invitationProbe ? 'invitation-baseline.json' : invitationOnly ? 'invitation-results.json' : probeOnly ? 'baseline.json' : 'results.json'), JSON.stringify({ passed: checks.length, observations, checks }, null, 2));
} finally {
  await Promise.race([closeBrowser().catch(() => {}), sleep(2000)]);
  await Promise.race([browserExit, sleep(2000)]);
  if (!browserExited) { browser.kill(); await Promise.race([browserExit, sleep(2000)]); }
  socket?.close(); await vite.close();
  if (browserExited && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('aisu-profile-account-')) {
    try { await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { console.warn('Temporary browser profile retained:', profile, error.code); }
  }
}
