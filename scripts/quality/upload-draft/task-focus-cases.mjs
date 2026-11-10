export async function verifyTaskFocus({ command, evaluate, wait, ensure, sleep, fresh, shot, baseline }) {
  const row = id => `document.querySelector('[aria-label="《${id}》翻译任务"]')`;
  const key = async name => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: name === 'Enter' ? 13 : 9, ...(name === 'Enter' ? { text: '\r' } : {}) });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: name === 'Enter' ? 13 : 9 });
    await sleep(100);
  };
  const activate = async expression => {
    await evaluate(`(()=>{const e=${expression};e.scrollIntoView({block:'center'});e.focus({preventScroll:true})})()`);
    await key('Enter');
  };
  await fresh('taskMessages', 1536, 864, false);
  await wait(`${row('paused')}!==null`);
  await evaluate('draftFixture.translationActionStatus=200');
  await activate(`${row('paused')}.querySelector('[title=继续翻译]')`);
  await wait(`${row('paused')}.textContent.includes('已加入队列')`);
  const resumed = await evaluate(`({tag:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label'),title:document.activeElement.title,inside:${row('paused')}.contains(document.activeElement)})`);
  console.log('FOCUS_OBSERVED ' + JSON.stringify({ resumed }));
  if (baseline) return;
  ensure(resumed.inside && resumed.title === '暂停并保留已完成进度', 'resuming a task keeps keyboard focus on its replacement control', resumed);

  const panel = `document.querySelector('[role=region][aria-label=任务进度]')`;
  const focused = (owner, control) => `(${owner})?.contains(document.activeElement)&&document.activeElement.dataset.taskFocusControl===${JSON.stringify(control)}`;
  const release = async () => { await evaluate('draftFixture.holdTranslationActions=false;draftFixture.pendingTranslationActions.splice(0).forEach(p=>p.resolve())'); await sleep(150); };
  const submitRecord = `document.querySelector('[data-translation-submission]')`;
  const setup = async (viewport, extra = '') => {
    const [width, height, touch, dark, font] = viewport;
    await fresh('taskFocus' + (dark ? '&dark' : '') + extra, width, height, touch);
    await evaluate(`document.documentElement.style.fontSize='${font}px';draftFixture.translationActionStatus=200`);
    await wait(`${row('paused')}!==null`);
  };
  const edit = async text => {
    await evaluate(`(()=>{const e=document.querySelector('textarea[placeholder=直接粘贴文章或翻译好的正文]');e.scrollIntoView({block:'center'});e.focus({preventScroll:true})})()`);
    await command('Input.insertText', { text });
  };
  for (const viewport of [
    [1536, 864, false, false, 16], [1536, 864, false, true, 16],
    [768, 1024, true, true, 24], [390, 844, true, false, 16], [320, 640, true, true, 32],
  ]) {
    const [width, height, touch, dark, font] = viewport, label = `${width} ${dark ? 'dark' : 'light'} ${font}px`;
    await setup(viewport);
    await evaluate('draftFixture.holdTranslationActions=true');
    await activate(`${row('paused')}.querySelector('[data-task-focus-control=resume]')`);
    await wait('draftFixture.pendingTranslationActions.length===1');
    ensure(await evaluate(`document.activeElement===${row('paused')}&&${row('paused')}.getAttribute('aria-busy')==='true'`), label + ' pending actions keep focus in their busy row');
    await evaluate(`${row('paused')}.querySelector('[data-task-focus-control=resume]').click()`);
    ensure(await evaluate('draftFixture.translationActions.length===1'), label + ' repeating a pending control cannot issue another request');
    await release(); await wait(focused(row('paused'), 'pause'));
    ensure(true, label + ' resume focuses the replacement pause control');
    await activate(`${row('paused')}.querySelector('[data-task-focus-control=pause]')`);
    await wait(focused(row('paused'), 'resume'));
    ensure(await evaluate(`document.activeElement.title==='取消暂停'`), label + ' requesting pause retains focus on the cancel-pause action');
    await key('Tab');
    ensure(await evaluate(`${row('paused')}.contains(document.activeElement)&&document.activeElement.dataset.taskFocusControl==='open'`), label + ' Tab continues within the updated task instead of returning to the page start');
    await evaluate(`${row('paused')}.querySelector('[data-task-focus-control=resume]').focus()`);
    await shot('task-focus-pause-' + label.replaceAll(' ', '-'));

    await setup(viewport);
    await evaluate('draftFixture.translationActionStatus=503;draftFixture.holdTranslationActions=true');
    await activate(`${row('paused')}.querySelector('[data-task-focus-control=resume]')`);
    await wait('draftFixture.pendingTranslationActions.length===1'); await release();
    await wait(`${row('paused')}.querySelector('[role=alert]')!==null&&${focused(row('paused'), 'resume')}`);
    ensure(true, label + ' failed actions restore the same control beside the visible error');
    await evaluate('draftFixture.translationActionStatus=200');
    const failed = `Array.from(document.querySelectorAll('[data-task-focus-id]')).find(e=>e.dataset.taskFocusId==='translation:failed-long')`;
    await activate(`${failed}.querySelector('[data-task-focus-control=retry]')`);
    await wait(focused(failed, 'pause'));
    ensure(await evaluate(`${failed}.textContent.includes('已加入队列')`), label + ' retry preserves task identity when history moves into the active list');
    await activate(`${row('paused')}.querySelector('[data-task-focus-control=delete]')`);
    await wait(`${row('paused')}===null`);
    ensure(await evaluate(focused(row('waiting'), 'pause')), label + ' deleting a row focuses the next task action');
    const processing = row('processing');
    await evaluate(`${processing}.querySelector('[data-task-focus-control=pause]').focus();Object.assign(draftFixture.translationJobs.find(j=>j.id==='processing'),{status:'ready',progress:100});window.dispatchEvent(new Event('focus'))`);
    await wait(focused(processing, 'open'));
    ensure(true, label + ' background completion moves focus with its task into history');

    await setup(viewport);
    await activate(`${submitRecord}.querySelector('[data-task-focus-control=retry]')`);
    await wait(`draftFixture.translationSubmissions.length===1&&${focused(submitRecord, 'retry')}`);
    ensure(true, label + ' an unconfirmed submission retry restores its original action');
    await evaluate('draftFixture.translationSubmitStatus=200');
    await activate(`${submitRecord}.querySelector('[data-task-focus-control=retry]')`);
    await wait(`${submitRecord}===null&&${focused(row('已确认提交的译稿'), 'pause')}`);
    ensure(true, label + ' accepted submissions focus the resulting server task');

    await setup(viewport);
    await evaluate('draftFixture.holdTranslationActions=true');
    await activate(`${row('paused')}.querySelector('[data-task-focus-control=resume]')`);
    await wait('draftFixture.pendingTranslationActions.length===1');
    await edit('正在编辑的新正文。'); await release();
    await wait(`${row('paused')}.textContent.includes('已加入队列')`);
    ensure(await evaluate(`document.activeElement.tagName==='TEXTAREA'&&document.activeElement.value==='正在编辑的新正文。'`), label + ' late success never steals focus or text from the editor');

    await setup(viewport);
    await evaluate('draftFixture.translationJobs=draftFixture.translationJobs.filter(j=>j.id==="ready");window.dispatchEvent(new Event("focus"))');
    await wait(`document.querySelectorAll('[data-task-focus-id^="translation:"]').length===1`);
    await activate(`${submitRecord}.querySelector('[data-task-focus-control=remove]')`);
    await wait(`${submitRecord}===null`);
    ensure(await evaluate(focused(row('ready'), 'open')), label + ' removing a local submission keeps focus on the remaining task');
    await activate(`${panel}.querySelector('[data-task-focus-control=clear]')`);
    await wait(`document.querySelectorAll('[data-task-focus-id]').length===0&&${panel}.getAttribute('aria-busy')==='false'`);
    ensure(await evaluate(`document.activeElement===${panel}&&${panel}.querySelector('[data-task-focus-control=clear]').disabled&&draftFixture.clearRequests.length===2`), label + ' clearing the last records leaves focus on the empty task region');

    await setup(viewport);
    await evaluate(`document.querySelector('#upload-mode-file').click();draftFixture.uploadStatus=503`);
    await wait(`document.querySelector('[aria-label=选择图书文件]')!==null`);
    await evaluate(`(()=>{const e=document.querySelector('[aria-label=选择图书文件]'),d=new DataTransfer();d.items.add(new File(['正文'],'focus.txt',{type:'text/plain'}));e.files=d.files;e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    const upload = `document.querySelector('.upload-task-item')`;
    await wait(`${upload}?.querySelector('[data-task-focus-control=retry]')!==null&&draftFixture.uploads.length===1`);
    await evaluate('draftFixture.uploadStatus=200');
    await activate(`${upload}.querySelector('[data-task-focus-control=retry]')`);
    await wait(`${upload}?.querySelector('[data-task-focus-control=open]')!==null&&${focused(upload, 'open')}`);
    ensure(await evaluate('draftFixture.uploads.length===2'), label + ' retry follows local upload replacement and server acknowledgement to its book link');
    ensure(await evaluate('document.documentElement.scrollWidth<=innerWidth'), label + ' focused task states fit the viewport');
  }

  const desktop = [1536, 864, false, true, 16];
  await setup(desktop);
  await evaluate('draftFixture.holdTranslationActions=true');
  await activate(`${row('paused')}.querySelector('[data-task-focus-control=resume]')`);
  await wait('draftFixture.pendingTranslationActions.length===1');
  await evaluate(`draftFixture.translationJobs=[];draftFixture.switchAccount('draft-user-b')`);
  await wait(`document.querySelectorAll('[data-task-focus-id]').length===0`);
  await edit('乙账号正在写的正文。'); await release(); await sleep(150);
  const switchedAccount = await evaluate(`({tag:document.activeElement.tagName,value:document.activeElement.value,remainingJobs:document.querySelectorAll('[data-task-focus-id^="translation:"]').length,aborted:draftFixture.translationActions[0].aborted})`);
  ensure(switchedAccount.tag==='TEXTAREA'&&switchedAccount.value==='乙账号正在写的正文。'&&switchedAccount.remainingJobs===0&&switchedAccount.aborted, 'old account responses cannot restore task focus or data into a different account', switchedAccount);
  await setup(desktop);
  await evaluate('draftFixture.holdTranslationActions=true');
  await activate(`${row('paused')}.querySelector('[data-task-focus-control=resume]')`);
  await wait('draftFixture.pendingTranslationActions.length===1');
  await evaluate(`draftFixture.navigate('/draft-away')`); await wait(`document.querySelector('#reopen')!==null`);
  await evaluate(`document.querySelector('#reopen').focus()`); await release();
  ensure(await evaluate(`document.activeElement.id==='reopen'&&draftFixture.translationActions[0].aborted`), 'leaving the upload page cancels pending focus restoration');
}
