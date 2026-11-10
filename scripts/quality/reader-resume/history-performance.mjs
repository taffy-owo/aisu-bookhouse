import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const label = process.argv[2] ?? 'current';
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) throw Error('Use a short report label containing letters, digits or hyphens.');
const reportDir = path.join(root, 'tmp', 'chapter-history-profile');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(root, 'tmp', 'chapter-history-profile.html'), '<!doctype html><title>Isolated history profile</title>');
const vite = await createServer({ root, optimizeDeps: { entries: ['tmp/chapter-history-profile.html'] }, server: { host: '127.0.0.1', port: 0 }, cacheDir: path.join(reportDir, '.vite') });
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aisu-history-profile-'));
const executable = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(candidate => candidate && fs.existsSync(candidate));
if (!executable) { await vite.close(); throw Error('Set CHROME_PATH to a Chromium browser executable.'); }
const child = spawn(executable, ['--headless', '--no-first-run', '--disable-background-networking', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const exited = new Promise(resolve => child.once('exit', resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let tabs;
  for (let i = 0; i < 100; i++) {
    try { tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await sleep(100); }
  }
  if (!tabs) throw Error('Chrome did not start');
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const calls = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), pending = calls.get(message.id);
    if (pending) { calls.delete(message.id); message.error ? pending.reject(Error(JSON.stringify(message.error))) : pending.resolve(message.result); }
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; calls.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await command('Page.navigate', { url: origin + '/tmp/chapter-history-profile.html' });
  await sleep(800);
  const result = await command('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const { saveChapterPosition, readChapterPosition } = await import('/src/modules/reader/services/chapterPositionHistory.ts');
    const scope = 'aisu-bookhouse:chapter-position-history:profile';
    const prefix = 'aisu-bookhouse:chapter-history-v2:' + encodeURIComponent(scope) + ':';
    const anchor = { blockIndex: 12, blockText: '文'.repeat(64), offsetRatio: .2, viewportOffset: 80, sourceOffset: 480,
      sourceViewportOffset: 84, sourceSignature: '900:abcd0123abcd0123', sourceContext: { before: '前'.repeat(96), after: '后'.repeat(96) } };
    const reports = [];
    for (const format of ['legacy', 'journal']) for (const count of [100, 1600, 4800]) {
      localStorage.clear();
      localStorage.setItem('aisu-bookhouse:session', JSON.stringify({ id: 'profile', nickname: 'Profile', role: 'user', status: 'active' }));
      const history = {};
      for (let index = 0; index < count; index++) {
        const bookId = 'history-' + Math.floor(index / 200), chapterKey = 'chapter:' + index;
        const entry = { ratio: .4, updatedAt: new Date(Date.now() - 1000000 + index).toISOString(), anchor };
        if (format === 'legacy') (history[bookId] ??= {})[chapterKey] = entry;
        else localStorage.setItem(prefix + index, JSON.stringify({ kind: 'position', bookId, chapterKey, entry, order: index }));
      }
      if (format === 'legacy') localStorage.setItem(scope, JSON.stringify(history));
      saveChapterPosition('current', 1, .2, new Date().toISOString(), 'current', anchor);
      const durations = [];
      for (let index = 0; index < 35; index++) {
        await new Promise(resolve => setTimeout(resolve, 0));
        const start = performance.now();
        saveChapterPosition('current', 1, .2 + index / 1000, new Date(Date.now() + index).toISOString(), 'current', anchor);
        durations.push(performance.now() - start);
      }
      if (Math.abs(readChapterPosition('current', 1, 'current').ratio - .234) > .000001) throw Error('Last saved position was lost');
      const sorted = [...durations].sort((a,b) => a-b);
      reports.push({ format, seeded: count, storageKeys: localStorage.length,
        characters: Array.from({length:localStorage.length}, (_,i) => { const key=localStorage.key(i); return key.length + localStorage.getItem(key).length; }).reduce((a,b) => a+b, 0),
        p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.floor(sorted.length*.95)], maximum: sorted.at(-1), durations });
    }
    return reports;
  })()` });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  fs.writeFileSync(path.join(reportDir, label + '.json'), JSON.stringify(result.result.value, null, 2));
  console.log(JSON.stringify(result.result.value.map(({durations,...summary}) => summary), null, 2));
} finally {
  socket?.close();
  child.kill();
  await exited;
  await vite.close();
}
