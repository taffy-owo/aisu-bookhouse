import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verifyProviderInteractions } from './provider-cases.mjs';
import { verifyChannelInteractions, probeChannelInteractions } from './channel-cases.mjs';
import { verifyChannelBoundaries, probeChannelBoundaries } from './channel-boundary-cases.mjs';
import { verifyChannelEditors, probeChannelEditors } from './channel-editor-cases.mjs';
import { verifyProviderReset, probeProviderReset } from './provider-reset-cases.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const reportDir = path.join(root, 'tmp/settings-provider-results');
fs.mkdirSync(reportDir, { recursive: true });
const probeOnly = process.argv.includes('--probe');
const channelProbe = process.argv.includes('--channel-probe');
const channelBoundary = process.argv.includes('--channel-boundaries');
const channelEditor = process.argv.includes('--channel-editors');
const providerReset = process.argv.includes('--provider-reset');
const channelOnly = process.argv.includes('--channels') || channelProbe || channelBoundary || channelEditor;
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
if (!executable) throw Error('Set CHROME_PATH to a Chromium executable');
const freePort = async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
};
// Optimized React dependencies must remain outside the React Refresh source filter.
const vite = await createServer({ root, cacheDir: path.join(reportDir, 'node_modules/.vite', String(process.pid)), optimizeDeps: { entries: ['scripts/quality/settings-provider/fixture.html'] }, server: { host: '127.0.0.1', port: await freePort(), strictPort: true } });
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
const port = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aisu-settings-provider-'));
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
  const wait = async expression => { for (let n = 0; n < 150; n++) { if (await evaluate(expression)) return; await sleep(80); } throw Error('Timeout ' + expression + ' ' + await evaluate('document.body.innerText.slice(-1800)')); };
  const ensure = (value, label, detail) => { if (!value) throw Error(label + ' ' + JSON.stringify(detail)); checks.push(label); console.log('PASS ' + label); };
  const input = async (selector, value) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(40); };
  const click = async expression => { const point = await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing click target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded target '+e.textContent);return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await sleep(80); };
  const key = async (key, shift = false) => { const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, ' ': 32 }; await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: codes[key], modifiers: shift ? 8 : 0, ...(key === 'Enter' ? { text: '\r' } : key === ' ' ? { text: ' ' } : {}) }); await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: codes[key], modifiers: shift ? 8 : 0 }); await sleep(80); };
  const fresh = async (width = 1536, height = 864, touch = false, dark = false, font = 16) => {
    await command('Page.navigate', { url: 'about:blank' }); await wait('location.href==="about:blank"');
    await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
    await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await command('Page.navigate', { url: origin + '/scripts/quality/settings-provider/fixture.html?' + (dark ? 'dark&' : '') + (channelOnly || providerReset ? 'channels' : '') });
    await wait('!!document.querySelector("#translation-model") && !!settingsFixture.navigate');
    await evaluate(`document.documentElement.style.fontSize='${font}px';sessionStorage.clear();document.querySelectorAll('.settings-disclosure')[${channelOnly ? 1 : 0}].open=true`);
    if (channelOnly) await wait(`!!document.querySelector('[aria-label="翻译渠道设置"]')`);
  };
  const section = kind => `document.querySelector('#${kind}-model').closest('section')`;
  const action = (kind, text) => `Array.from(${section(kind)}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const trigger = kind => `document.querySelector('button[aria-controls="${kind}-model-options"]')`;
  const loadModels = async kind => { await click(action(kind, '获取模型')); await wait(`!!${trigger(kind)}`); };
  const shot = async name => { const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(reportDir, name + '.png'), Buffer.from(result.data, 'base64')); };
  await command('Page.enable'); await command('Runtime.enable'); await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (providerReset) await (probeOnly ? probeProviderReset : verifyProviderReset)({ command, evaluate, wait, ensure, input, click, key, fresh, sleep, shot, observations });
  else if (channelEditor) await (probeOnly ? probeChannelEditors : verifyChannelEditors)({ command, evaluate, wait, ensure, input, click, key, fresh, sleep, shot, observations });
  else if (channelBoundary) await (probeOnly ? probeChannelBoundaries : verifyChannelBoundaries)({ command, evaluate, wait, ensure, input, click, key, fresh, sleep, shot, observations });
  else if (channelOnly) await (channelProbe ? probeChannelInteractions : verifyChannelInteractions)({ command, evaluate, wait, ensure, input, click, key, fresh, sleep, shot, observations });
  else if (!probeOnly) await verifyProviderInteractions({ command, evaluate, wait, ensure, input, click, key, fresh, section, action, trigger, loadModels, sleep, shot });
  else {
    await fresh(); await loadModels('translation');
    await evaluate(`${trigger('translation')}.focus()`); await key('Enter');
    const opening = await evaluate(`({active:document.activeElement?.getAttribute('role'),selected:document.activeElement?.textContent,open:!!document.querySelector('#translation-model-options')})`);
    await key('ArrowDown');
    const arrow = await evaluate(`({active:document.activeElement?.getAttribute('role'),text:document.activeElement?.textContent})`);
    await evaluate(`document.querySelector('#translation-model-options [role=option]').focus()`); await key('Escape');
    const escape = await evaluate(`({open:!!document.querySelector('#translation-model-options'),triggerFocused:document.activeElement===${trigger('translation')},active:document.activeElement?.tagName})`);
    await click(trigger('translation')); await evaluate(`document.querySelector('#translation-provider-api-key').focus()`); await key('Tab');
    observations.push({ opening, arrow, escape, stayedOpenAfterLeaving: await evaluate(`!!document.querySelector('#translation-model-options')`) });
    await fresh(320, 640, true); await evaluate(`settingsFixture.hold=true;settingsFixture.fail=true;settingsFixture.error='upstream_connection_diagnostic_'.repeat(90)`);
    await evaluate(`(()=>{const b=${action('translation', '获取模型')};b.click();b.click()})()`); await sleep(100);
    const requests = await evaluate('settingsFixture.requests.length');
    await evaluate('settingsFixture.release()'); await wait(`!!${section('translation')}.querySelector('[role=alert]')`);
    const error = await evaluate(`(()=>{const e=${section('translation')}.querySelector('[role=alert]');return {width:e.clientWidth,scrollWidth:e.scrollWidth,page:document.documentElement.scrollWidth,viewport:innerWidth}})()`);
    observations.push({ requests, error }); await shot('baseline-narrow-error');
  }
  ensure(errors.length === 0, 'no browser runtime or console errors', errors);
  fs.writeFileSync(path.join(reportDir, providerReset ? probeOnly ? 'provider-reset-baseline.json' : 'provider-reset-results.json' : channelEditor ? probeOnly ? 'channel-editor-baseline.json' : 'channel-editor-results.json' : channelBoundary ? probeOnly ? 'channel-boundary-baseline.json' : 'channel-boundary-results.json' : channelProbe ? 'channel-baseline.json' : channelOnly ? 'channel-results.json' : probeOnly ? 'baseline.json' : 'results.json'), JSON.stringify({ passed: checks.length, observations, checks }, null, 2));
  console.log('OBSERVATIONS ' + JSON.stringify(observations));
} catch (error) {
  console.log('FAILURE ' + String(error));
  if (socket?.readyState === 1) {
    const result = await new Promise(resolve => { const id = 1e9; const handler = ({ data }) => { const response = JSON.parse(data); if (response.id === id) { socket.removeEventListener('message', handler); resolve(response.result); } }; socket.addEventListener('message', handler); socket.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
    if (result?.data) fs.writeFileSync(path.join(reportDir, 'failure.png'), Buffer.from(result.data, 'base64'));
  }
  throw error;
} finally {
  await Promise.race([closeBrowser().catch(() => {}), sleep(2000)]);
  await Promise.race([browserExit, sleep(2000)]);
  if (!browserExited) { browser.kill(); await Promise.race([browserExit, sleep(2000)]); }
  socket?.close(); await vite.close();
  if (browserExited && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('aisu-settings-provider-')) {
    try { await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { console.warn('Temporary browser profile retained:', profile, error.code); }
  }
}
