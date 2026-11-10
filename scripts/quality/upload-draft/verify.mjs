import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verifyTaskMessages } from './task-message-cases.mjs';
import { verifyTaskFocus } from './task-focus-cases.mjs';

// Real UploadPage, isolated storage, fake HTTP/XHR and no production writes.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const reports = path.join(root, 'tmp/upload-draft-results');
fs.mkdirSync(reports, { recursive: true });
const baseline = process.argv.includes('--baseline');
const strictMode = process.argv.includes('--strict');
const acceptanceBaseline = process.argv.includes('--acceptance-baseline');
const acceptanceOnly = process.argv.includes('--acceptance');
const messagesOnly = process.argv.includes('--messages');
const focusBaseline = process.argv.includes('--focus-baseline');
const focusOnly = process.argv.includes('--focus') || focusBaseline;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
const forwardedErrors = [];
vite.environments.client.hot.on('vite:forward-console', payload => { if (payload.type === 'log' && payload.data.level === 'error') forwardedErrors.push(payload.data.message); });
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => p && fs.existsSync(p));
if (!executable) throw Error('Set CHROME_PATH to a Chromium executable.');
const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aisu-upload-draft-'));
const chrome = spawn(executable, ['--headless', '--no-first-run', '--disable-background-networking', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tabs;
for (let n = 0; n < 80; n++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await sleep(100); } }
if (!tabs) { chrome.kill(); await vite.close(); throw Error('Chromium did not start'); }
const socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
const calls = new Map(), errors = [], checks = []; let nextId = 0;
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data), pending = calls.get(message.id);
  if (message.method === 'Runtime.exceptionThrown' || (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')) errors.push(message);
  if (pending) { calls.delete(message.id); message.error ? pending.reject(Error(JSON.stringify(message.error))) : pending.resolve(message.result); }
};
socket.onclose = () => { for (const pending of calls.values()) pending.reject(Error('Browser closed')); calls.clear(); };
function command(method, params = {}) { return new Promise((resolve, reject) => { const id = ++nextId; calls.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function wait(expression) { for (let n = 0; n < 120; n++) { if (await evaluate(expression)) return; await sleep(80); } throw Error('Timeout ' + expression + ' ' + await evaluate('document.body.innerText.slice(-1600)')); }
function ensure(value, label, details) { if (!value) throw Error(label + ' ' + JSON.stringify(details)); checks.push(label); console.log('PASS ' + label); }
async function input(selector, value) { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(30); }
async function fresh(query = '', width = 1536, height = 864, touch = false) {
  await command('Page.navigate', { url: 'about:blank' }); await wait('location.href==="about:blank"'); await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch }); await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  await command('Page.navigate', { url: origin + '/scripts/quality/upload-draft/fixture.html?' + query + (strictMode ? '&strict' : '') });
  await manual();
}
async function manual() { await wait('!!document.querySelector("#upload-mode-manual")'); await evaluate('document.querySelector("#upload-mode-manual").click()'); await wait('!!document.querySelector("textarea[placeholder=直接粘贴文章或翻译好的正文]")'); }
const content = 'textarea[placeholder=直接粘贴文章或翻译好的正文]';
async function shot(name) { const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(reports, name + '.png'), Buffer.from(result.data, 'base64')); }
const retry = "Array.from(document.querySelectorAll('form button')).find(e=>e.textContent.trim().startsWith('重试'))";
async function clickRetry() { await evaluate(`(${retry}).click()`); await sleep(70); }
async function reopen() { await evaluate('draftFixture.navigate("/draft-away")'); await wait('!!document.querySelector("#reopen")'); await evaluate('document.querySelector("#reopen").click()'); await manual(); }
async function value() { return evaluate('document.querySelector(' + JSON.stringify(content) + ').value'); }
async function submit() { await evaluate('document.querySelector("form button[type=submit]").click()'); }
async function reload() {
  const marker = String(Date.now()); await evaluate(`draftFixture.reloadMarker=${JSON.stringify(marker)}`);
  await command('Page.reload');
  await wait(`typeof draftFixture!=='undefined' && draftFixture.reloadMarker!==${JSON.stringify(marker)}`);
  await manual();
}
const taskReadStatus = '[aria-label=上传任务读取状态]';
const retryTaskRead = `document.querySelector('${taskReadStatus} button')`;
async function releaseTaskReads() {
  await evaluate('draftFixture.holdTaskReads=false;draftFixture.holdTasksAfterAccept=false;draftFixture.pendingTaskReads.splice(0).forEach(r=>r.resolve())');
  await sleep(120);
}
async function verifyAcceptance() {
  for (const [width, height, touch, dark] of [[320, 568, true, false], [390, 844, true, true], [768, 1024, true, false], [768, 1024, true, true], [1536, 864, false, false], [1536, 864, false, true]]) {
    const label = width + ' acceptance ' + (dark ? 'dark' : 'light');
    await fresh('seed&failTasksAfterAccept' + (dark ? '&dark' : ''), width, height, touch);
    await evaluate(`(()=>{const form=document.querySelector(${JSON.stringify(content)}).form;form.requestSubmit();form.requestSubmit()})()`);
    await wait('document.body.innerText.includes("原文件已保存，可在任务记录") && document.body.innerText.includes("模拟上传任务读取失败")');
    ensure(await value() === '' && await evaluate('draftFixture.uploads.length===1 && draftFixture.saved()===null && !document.querySelector(".upload-workspace [role=alert]") && document.querySelector(".upload-task-item").innerText.includes("已完成")'), label + ' a confirmed save clears the form once despite a failed task-list read and duplicate submit events');
    await input(content, '下一篇还在编辑的正文。');
    await evaluate(`(${retryTaskRead}).scrollIntoView({block:'center'})`); await sleep(70);
    await wait(`!!(${retryTaskRead}) && !(${retryTaskRead}).disabled`);
    ensure(await evaluate(`(()=>{const button=${retryTaskRead},r=button.getBoundingClientRect(),w=document.documentElement.clientWidth;return !button.disabled&&r.height>=44&&r.left>=0&&r.right<=w&&button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))&&document.documentElement.scrollWidth<=w})()`), label + ' the separate task-read retry remains tappable and fits the viewport');
    await shot('acceptance-read-failure-' + width + '-' + (dark ? 'dark' : 'light'));
    await evaluate(`draftFixture.failTasksAfterAccept=false;(${retryTaskRead}).click()`);
    await wait(`!document.querySelector('${taskReadStatus}')`);
    ensure(await value() === '下一篇还在编辑的正文。' && await evaluate('draftFixture.uploads.length===1 && document.querySelectorAll(".upload-task-item").length===1'), label + ' retry reads only tasks and preserves the next article without another upload');
  }

  await fresh('seed&holdTasksAfterAccept'); await submit();
  await wait('draftFixture.pendingTaskReads.length>0 && document.body.innerText.includes("原文件已保存，可在任务记录")');
  ensure(await value() === '' && await evaluate('!document.querySelector("textarea").disabled && draftFixture.uploads.length===1'), 'a held task refresh does not keep an acknowledged manual save busy');
  await input('input[placeholder=留空则使用正文第一行]', '第二篇');
  await input(content, '第二篇独立的正文。'); await submit();
  await wait('draftFixture.uploads.length===2 && document.querySelector("textarea[placeholder=直接粘贴文章或翻译好的正文]").value===""');
  ensure(await evaluate('document.querySelectorAll(".upload-task-item").length===2 && draftFixture.uploads[0].headers["Idempotency-Key"]!==draftFixture.uploads[1].headers["Idempotency-Key"]'), 'a second article can be saved with a new identity while the first task refresh is still held');
  await releaseTaskReads();
  ensure(await evaluate('document.querySelectorAll(".upload-task-item").length===2 && document.body.innerText.includes("第二篇.txt")'), 'an older task snapshot cannot erase a later upload receipt');

  await fresh('seed&holdTaskReads'); await wait('draftFixture.pendingTaskReads.length>0'); await submit();
  await wait('document.body.innerText.includes("原文件已保存，可在任务记录")'); await releaseTaskReads();
  ensure(await value() === '' && await evaluate('draftFixture.uploads.length===1 && document.querySelector(".upload-task-item").innerText.includes("已完成")'), 'a delayed initial task read cannot erase an upload accepted while the page was loading');

  await fresh(); await evaluate('document.querySelector("#upload-mode-file").click();draftFixture.failTasksAfterAccept=true;draftFixture.fileStatuses["failed.txt"]=503');
  await evaluate(`(()=>{const input=document.querySelector('[aria-label=选择图书文件]'),data=new DataTransfer();for(const name of ['accepted.txt','failed.txt'])data.items.add(new File(['文章正文'],name,{type:'text/plain'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait('draftFixture.uploads.length===2 && !!document.querySelector("[aria-label^=重试failed]") && !!document.querySelector("[aria-label^=查看accepted]") && document.body.innerText.includes("模拟上传任务读取失败")');
  ensure(await evaluate('document.querySelectorAll(".upload-task-item").length===2 && !document.querySelector("[aria-label=选择图书文件]").disabled'), 'a partial batch keeps both the accepted receipt and the actionable local failure after task refresh fails');
  await evaluate('draftFixture.fileStatuses["failed.txt"]=200;document.querySelector("[aria-label^=重试failed]").click()');
  await wait('draftFixture.uploads.length===3 && !document.querySelector("[aria-label^=重试failed]")');
  ensure(await evaluate('draftFixture.uploads.filter(r=>r.fileName==="accepted.txt").length===1 && draftFixture.uploads.filter(r=>r.fileName==="failed.txt").length===2 && draftFixture.uploads[1].headers["Idempotency-Key"]===draftFixture.uploads[2].headers["Idempotency-Key"] && document.querySelectorAll(".upload-task-item").length===2'), 'retry resends only the failed file with its reserved identity and retains the successful file');

  await fresh('seed&failTasksAfterAccept'); await evaluate('draftFixture.acceptedStatus="failed"'); await submit();
  await wait('document.body.innerText.includes("原文件已保存，可在任务记录") && !!document.querySelector("[aria-label^=重新解析灯下的来信]") && document.body.innerText.includes("模拟上传任务读取失败")');
  ensure(await value() === '' && await evaluate('!document.querySelector("[aria-label^=重试灯下的来信]") && !document.querySelector(".upload-task-item").innerText.includes("正在解析")'), 'acknowledged parsing failure clears the saved article and offers reparse instead of another upload');
  await evaluate(`draftFixture.failTasksAfterAccept=false;draftFixture.holdTaskReads=true;(${retryTaskRead}).click()`); await wait('draftFixture.pendingTaskReads.length>0');
  await evaluate('document.querySelector("[aria-label^=重新解析灯下的来信]").click()');
  await wait('draftFixture.reprocesses.length===1 && document.querySelector(".upload-task-item").innerText.includes("已完成")');
  await releaseTaskReads();
  ensure(await evaluate('draftFixture.uploads.length===1 && draftFixture.reprocesses.length===1 && document.querySelector(".upload-task-item").innerText.includes("已完成") && !document.querySelector("[aria-label^=重新解析灯下的来信]")'), 'an older failed-task snapshot cannot regress a confirmed reparse or cause an extra file upload');

  await fresh('seed&failTasksAfterAccept'); await evaluate('draftFixture.acceptedStatus="queued"'); await submit();
  await wait('document.body.innerText.includes("原文件已保存，可在任务记录") && document.body.innerText.includes("模拟上传任务读取失败")');
  ensure(await value() === '' && await evaluate('document.querySelector(".upload-task-item").innerText.includes("等待中") && !document.querySelector(".upload-task-item").innerText.includes("处理中")'), 'a queued acknowledgement stays queued rather than being mistaken for active parsing');
  await evaluate(`for(const tasks of draftFixture.tasks.values())tasks.forEach(t=>{t.status='ready';t.progress=100});draftFixture.failTasksAfterAccept=false;(${retryTaskRead}).click()`);
  await wait('document.querySelector(".upload-task-item").innerText.includes("已完成")');
  ensure(await evaluate('draftFixture.uploads.length===1'), 'task-only refresh advances an accepted queued file to completion without resubmitting it');

  await fresh('seed&holdTasksAfterAccept'); await submit(); await wait('draftFixture.pendingTaskReads.length>0');
  await evaluate('draftFixture.seed("draft-user-b");draftFixture.switchAccount("draft-user-b")'); await sleep(120);
  await input(content, '乙账号正在编辑的正文。'); await releaseTaskReads();
  ensure(await value() === '乙账号正在编辑的正文。' && await evaluate('!document.querySelector(".upload-task-item") && !document.body.innerText.includes("原文件已保存，可在任务记录")'), 'an old-account task refresh cannot restore its receipts or success message in the new account');

  await fresh('seed&holdTasksAfterAccept'); await submit(); await wait('draftFixture.pendingTaskReads.length>0');
  await reopen(); await releaseTaskReads();
  ensure(await value() === '' && await evaluate('draftFixture.uploads.length===1 && document.querySelectorAll(".upload-task-item").length===1 && !document.body.innerText.includes("原文件已保存，可在任务记录")'), 'leaving and reopening during a held refresh keeps the submitted draft cleared and reloads its server task');
  ensure(errors.length===0 && forwardedErrors.length===0, 'acceptance checks have no uncaught browser exceptions or console errors', [...errors, ...forwardedErrors]);
}
try {
  await command('Page.enable'); await command('Runtime.enable');
  if (focusOnly) {
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await verifyTaskFocus({ command, evaluate, wait, ensure, sleep, fresh, shot, baseline: focusBaseline });
    ensure(errors.length===0 && forwardedErrors.length===0, 'task focus checks have no uncaught browser exceptions or console errors', [...errors, ...forwardedErrors]);
  } else if (messagesOnly) {
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await verifyTaskMessages({ command, evaluate, wait, ensure, sleep, fresh, shot });
    ensure(errors.length===0 && forwardedErrors.length===0, 'task message checks have no uncaught browser exceptions or console errors', [...errors, ...forwardedErrors]);
  } else if (acceptanceBaseline) {
    await fresh('seed&failTasksAfterAccept'); await submit(); await wait('document.body.innerText.includes("模拟上传任务读取失败")'); await sleep(250);
    const failedRead = await evaluate('({uploads:draftFixture.uploads.length,content:document.querySelector("textarea[placeholder=直接粘贴文章或翻译好的正文]").value,success:document.body.innerText.includes("原文件已保存，可在任务记录"),error:document.querySelector(".upload-workspace [role=alert]")?.textContent,task:document.querySelector(".upload-task-item")?.innerText})');
    await fresh('seed&holdTasksAfterAccept'); await submit(); await wait('draftFixture.pendingTaskReads.length>0'); await sleep(250);
    const heldRead = await evaluate('({uploads:draftFixture.uploads.length,busy:document.querySelector("form button[type=submit]").disabled,button:document.querySelector("form button[type=submit]").textContent,content:document.querySelector("textarea[placeholder=直接粘贴文章或翻译好的正文]").value})');
    await evaluate('draftFixture.holdTasksAfterAccept=false;draftFixture.pendingTaskReads.splice(0).forEach(r=>r.resolve())');
    fs.writeFileSync(path.join(reports, 'acceptance-baseline.json'), JSON.stringify({ failedRead, heldRead, errors }, null, 2));
    console.log(JSON.stringify({ failedRead, heldRead, errors }));
  } else if (acceptanceOnly) {
    await verifyAcceptance();
  } else if (baseline) {
    await fresh('failSet'); await input(content, '需要保存但存储已满的正文。'); await sleep(650);
    const failedSave = await evaluate('({stored:draftFixture.saved(),hasWarning:document.body.innerText.includes("草稿保存失败"),promisesSave:document.body.innerText.includes("内容会自动保存在此设备")})');
    await evaluate('draftFixture.navigate("/draft-away")'); await wait('!!document.querySelector("#reopen")'); await evaluate('document.querySelector("#reopen").click()'); await manual();
    const reopened = await evaluate('document.querySelector(' + JSON.stringify(content) + ').value');
    await fresh('seed&failRemove'); await evaluate('document.querySelector("form button[type=submit]").click()'); await wait('document.body.innerText.includes("原文件已保存")'); await sleep(650);
    const cleanup = await evaluate('({stored:draftFixture.saved(),uploads:draftFixture.uploads.length,hasWarning:document.body.innerText.includes("草稿未能清除")})');
    fs.writeFileSync(path.join(reports, 'baseline.json'), JSON.stringify({ failedSave, reopened, cleanup, errors }, null, 2));
    console.log(JSON.stringify({ failedSave, reopened, cleanup, errors }));
  } else {
    for (const [width, height, touch, dark] of [[320, 568, true, false], [390, 844, true, true], [768, 1024, true, false], [768, 1024, true, true], [1536, 864, false, false], [1536, 864, false, true]]) {
      const label = width + ' ' + (dark ? 'dark' : 'light');
      await fresh('failSet' + (dark ? '&dark' : ''), width, height, touch);
      await input(content, '需要保留的文章正文。'); await wait('document.body.innerText.includes("本机草稿保存失败")');
      ensure(await evaluate('draftFixture.saved()===null && !document.querySelector("form").innerText.includes("输入正文后会自动保存")'), label + ' failed writes show a truthful warning instead of the automatic-save promise');
      await evaluate(`(${retry}).scrollIntoView({block:'center'})`); await sleep(80);
      ensure(await evaluate(`(()=>{const button=${retry},r=button.getBoundingClientRect(),w=document.documentElement.clientWidth;return r.height>=44&&r.left>=0&&r.right<=w&&button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))&&document.documentElement.scrollWidth<=w})()`), label + ' persistence warning and retry stay readable and tappable without overflow');
      await shot('save-failure-' + width + '-' + (dark ? 'dark' : 'light'));
      await input(content, '刚刚补充的新正文。'); await clickRetry();
      ensure(await evaluate('JSON.parse(draftFixture.sets.at(-1).value).content==="刚刚补充的新正文。" && draftFixture.uploads.length===0'), label + ' retry uses the latest edit and sends no upload');
      await reopen();
      ensure(await value() === '刚刚补充的新正文。' && await evaluate('document.body.innerText.includes("本机草稿保存失败")'), label + ' an unsaved draft survives leaving and reopening within the same tab');
      await evaluate('draftFixture.failSet=false'); await clickRetry();
      ensure(await evaluate('draftFixture.saved().content==="刚刚补充的新正文。" && !document.body.innerText.includes("本机草稿保存失败") && draftFixture.uploads.length===0'), label + ' successful persistence retry clears the warning without submitting the book');
      await reload();
      ensure(await value() === '刚刚补充的新正文。', label + ' a confirmed local save survives a full reload');
    }

    await fresh(); await input(content, '切换页面前刚输入的正文。'); await reopen();
    ensure(await value() === '切换页面前刚输入的正文。' && await evaluate('draftFixture.saved().content==="切换页面前刚输入的正文。"'), 'route exit flushes the latest edit before the debounce expires');
    await input(content, '页面隐藏前刚输入的正文。'); await evaluate('window.dispatchEvent(new Event("pagehide"))');
    ensure(await evaluate('draftFixture.saved().content==="页面隐藏前刚输入的正文。"'), 'pagehide immediately flushes the latest draft');

    await fresh('failSet'); await input(content, '切换上传方式后也要保留的正文。'); await wait('document.body.innerText.includes("本机草稿保存失败")');
    for (const mode of ['file', 'translation']) {
      await evaluate(`document.querySelector('#upload-mode-${mode}').click()`); await sleep(60);
      ensure(await evaluate('Array.from(document.querySelectorAll("[role=status]")).some(e=>e.innerText.includes("本机草稿保存失败") && e.getClientRects().length>0) && Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="查看手动草稿")'), mode + ' mode keeps the unsaved manual-draft warning visible');
    }
    await evaluate('Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="查看手动草稿").click()'); await manual();
    ensure(await value() === '切换上传方式后也要保留的正文。', 'the persistent warning returns directly to the retained manual draft');

    await fresh(); await input(content, '甲账号尚未到自动保存时间的正文。'); await evaluate('draftFixture.switchAccount("draft-user-b")'); await sleep(120);
    ensure(await evaluate('draftFixture.saved("draft-user-a").content==="甲账号尚未到自动保存时间的正文。"') && await value() === '', 'account switching flushes the old draft before credentials change without leaking it into the next form');
    await fresh('failSet'); await input(content, '甲账号未写入的正文。'); await wait('document.body.innerText.includes("本机草稿保存失败")');
    await evaluate('draftFixture.seed("draft-user-b");draftFixture.switchAccount("draft-user-b")'); await sleep(100);
    ensure(await value() === '上次保留的文章正文。' && await evaluate('!document.body.innerText.includes("本机草稿保存失败")'), 'another account restores only its own persisted draft and warning state');
    await input(content, '乙账号未写入的正文。'); await wait('document.body.innerText.includes("本机草稿保存失败")');
    await evaluate('draftFixture.switchAccount("draft-user-a")'); await sleep(100);
    ensure(await value() === '甲账号未写入的正文。', 'failed local writes remain isolated and recoverable when returning to the original account');
    await evaluate('draftFixture.failSet=false'); await clickRetry();
    ensure(await evaluate('draftFixture.saved("draft-user-a").content==="甲账号未写入的正文。" && draftFixture.saved("draft-user-b").content==="上次保留的文章正文。"'), 'retry persists only the current account draft');
    await evaluate('draftFixture.switchAccount("draft-user-b")'); await sleep(100); await clickRetry();
    ensure(await value() === '乙账号未写入的正文。' && await evaluate('draftFixture.saved("draft-user-b").content==="乙账号未写入的正文。"'), 'the second account can separately persist its newer in-memory draft');

    await fresh('seed&failGet'); await sleep(650);
    ensure(await evaluate('draftFixture.saved().content==="上次保留的文章正文。" && draftFixture.removes.length===0 && document.body.innerText.includes("暂时无法读取本机草稿")'), 'a failed initial read never deletes the uninspected existing draft');
    await input('input[placeholder=未知作者]', '后来输入的作者'); await evaluate('draftFixture.failGet=false'); await clickRetry();
    ensure(await value() === '上次保留的文章正文。' && await evaluate('document.querySelector("input[placeholder=未知作者]").value==="后来输入的作者"'), 'read retry restores the old article while preserving newer metadata edits');
    await wait('draftFixture.saved().author==="后来输入的作者"');
    await fresh('seed&failGet'); await input(content, '我现在输入的新正文。'); await clickRetry();
    ensure(await value() === '我现在输入的新正文。' && await evaluate('draftFixture.saved().content==="我现在输入的新正文。"'), 'read retry cannot replace a newer article with an older saved draft');

    await fresh('seed&failRemove'); await submit(); await wait('document.body.innerText.includes("本机旧草稿未能清除")');
    ensure(await value() === '' && await evaluate('draftFixture.uploads.length===1 && document.body.innerText.includes("原文件已保存，无需再次提交") && draftFixture.saved().requestId'), 'confirmed upload success stays distinct from failed local cleanup');
    await clickRetry();
    ensure(await evaluate('draftFixture.uploads.length===1 && document.body.innerText.includes("本机旧草稿未能清除")'), 'failed cleanup retry never uploads the original article again');
    await reopen();
    ensure(await value() === '' && await evaluate('document.body.innerText.includes("本机旧草稿未能清除")'), 'failed cleanup does not resurrect the submitted article on a same-tab revisit');
    await evaluate('draftFixture.failRemove=false'); await clickRetry();
    ensure(await evaluate('draftFixture.saved()===null && draftFixture.uploads.length===1 && !document.body.innerText.includes("本机旧草稿未能清除")'), 'successful cleanup retry removes only the old local copy');
    await reload();
    ensure(await value() === '', 'a cleaned submitted draft remains absent after full reload');
    await fresh('seed&failRemove'); await submit(); await wait('document.body.innerText.includes("本机旧草稿未能清除")');
    await input(content, '下一篇新文章。'); await clickRetry();
    ensure(await value() === '下一篇新文章。' && await evaluate('draftFixture.saved().content==="下一篇新文章。" && !draftFixture.saved().requestId && draftFixture.uploads.length===1'), 'typing a new article supersedes an old cleanup retry without deleting or submitting the new text');

    await fresh('failSet'); await input(content, '上传失败后也要保留的正文。'); await evaluate('draftFixture.uploadStatus=503'); await submit(); await wait('document.body.innerText.includes("模拟上传失败")');
    await reopen();
    ensure(await value() === '上传失败后也要保留的正文。', 'failed server upload and failed local persistence still retain the article for a same-tab retry');
    await submit(); await wait('draftFixture.uploads.length===2 && document.body.innerText.includes("模拟上传失败")');
    ensure(await evaluate('draftFixture.uploads[0].headers["Idempotency-Key"]===draftFixture.uploads[1].headers["Idempotency-Key"]'), 'reopened unconfirmed manual submission keeps its original idempotency key');
    await evaluate('draftFixture.uploadStatus=200'); await submit(); await wait('document.body.innerText.includes("原文件已保存")');
    ensure(await value() === '' && await evaluate('draftFixture.uploads.length===3 && draftFixture.uploads[0].headers["Idempotency-Key"]===draftFixture.uploads[2].headers["Idempotency-Key"]'), 'a later confirmed upload clears the retained form using the same reserved submission');

    await fresh('seed'); await evaluate('draftFixture.holdUpload=true;draftFixture.seed("draft-user-b")'); await submit(); await wait('draftFixture.pendingUploads.length===1');
    await evaluate('draftFixture.switchAccount("draft-user-b")'); await sleep(100);
    await input(content, '乙账号正在编辑的新正文。'); await evaluate('draftFixture.holdUpload=false;draftFixture.pendingUploads.splice(0).forEach(resolve=>resolve())'); await sleep(250);
    ensure(await value() === '乙账号正在编辑的新正文。' && await evaluate('!document.body.innerText.includes("原文件已保存，可在任务记录") && draftFixture.saved("draft-user-a").content==="上次保留的文章正文。"'), 'a late old-account upload response cannot clear the next account draft or show an old success message');

    await fresh(); await input('input[placeholder=未知作者]', '只有作品信息'); await sleep(650);
    ensure(await evaluate('draftFixture.saved()===null && draftFixture.sets.length===0'), 'metadata without article text is still intentionally excluded from draft persistence');
    await verifyAcceptance();
    ensure(errors.length===0 && forwardedErrors.length===0, 'no uncaught browser exceptions or console errors', [...errors, ...forwardedErrors]);
  }
  fs.writeFileSync(path.join(reports, focusBaseline ? 'focus-baseline.json' : focusOnly ? 'focus-results.json' : messagesOnly ? 'message-results.json' : acceptanceOnly ? 'acceptance-results.json' : strictMode ? 'strict-results.json' : 'results.json'), JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  console.log('FAILURE', String(error), JSON.stringify(errors).slice(0, 2000)); await shot('failure'); throw error;
} finally {
  try { await Promise.race([command('Browser.close'), sleep(2000)]); } catch { chrome.kill(); }
  socket.close(); await vite.close(); await sleep(500);
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('aisu-upload-draft-')) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
