import fs from 'node:fs';
import path from 'node:path';

export async function verifyBookActions({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot, baseline, reportDir }) {
  const observations = [];
  const dialog = `document.querySelector('[role="dialog"]')`;
  const action = text => `Array.from(${dialog}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const key = async (name, shift = false) => {
    const codes = { Tab: 9, Escape: 27, Enter: 13 };
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: codes[name], modifiers: shift ? 8 : 0 });
    await sleep(70);
  };
  const visible = expression => evaluate(`(()=>{const e=${expression},r=e.getBoundingClientRect(),v=visualViewport;return r.left>=(v?.offsetLeft||0)&&r.right<=(v?.offsetLeft||0)+(v?.width||innerWidth)+1&&r.top>=(v?.offsetTop||0)&&r.bottom<=(v?.offsetTop||0)+(v?.height||innerHeight)+1&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
  const pointer = async expression => {
    await evaluate(`(()=>{const e=${expression},menu=e.closest('#book-action-menu');if(menu){const r=e.getBoundingClientRect(),m=menu.getBoundingClientRect();menu.scrollTop+=r.top+r.height/2-m.top-m.height/2;}else e.scrollIntoView({block:'center',inline:'nearest'});return true})()`); await sleep(140);
    if (!await visible(expression)) throw Error('Covered or clipped action: ' + expression + ' ' + await evaluate(`(()=>{const e=${expression},r=e.getBoundingClientRect();return JSON.stringify({rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML.slice(0,250),menuScroll:e.closest('#book-action-menu')?.scrollTop})})()`));
    await click(expression);
  };
  const open = async kind => {
    await pointer(`document.querySelector('[aria-label="更多操作"]')`);
    const labels = { delete: '删除图书', replace: '替换书籍文件', share: '分享到公共书库' };
    await wait(`!!document.querySelector('#book-action-menu')`);
    const target = `Array.from(document.querySelectorAll('#book-action-menu button')).find(e=>e.textContent.trim()===${JSON.stringify(labels[kind])})`;
    await pointer(target); await wait(`!!${dialog}`); await sleep(150);
  };
  const snapshot = () => evaluate(`(()=>{
    const d=${dialog},v=visualViewport,rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const filename=[...d.querySelectorAll('span')].find(e=>e.textContent.startsWith('new_translation_')&&e.childElementCount===0);
    return{dialog:rect(d),viewport:{left:v?.offsetLeft||0,top:v?.offsetTop||0,width:v?.width||innerWidth,height:v?.height||innerHeight},overflow:d.scrollWidth>d.clientWidth+1,scrollWidth:d.scrollWidth,portalOverflow:d.parentElement.scrollWidth>d.parentElement.clientWidth+1,close:rect(d.querySelector('button[aria-label]')),icons:[...d.querySelectorAll('button svg')].map(rect),fields:[...d.querySelectorAll('input:not([type=file]),textarea')].map(e=>({...rect(e),type:e.type})),filenameClipped:filename?filename.scrollWidth>filename.clientWidth+1:false,focusInside:d.contains(document.activeElement)};
  })()`);
  const fill = async (expression, text) => {
    await evaluate(`${expression}.scrollIntoView({block:'center'});${expression}.focus();${expression}.select();true`);
    await command('Input.insertText', { text }); await sleep(80);
  };
  const file = async code => {
    await evaluate(`(()=>{const e=${dialog}.querySelector('input[type=file]'),dt=new DataTransfer();dt.items.add(${code});e.files=dt.files;e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`); await sleep(90);
  };
  const reset = async (width = 1536, height = 864, touch = false, font = 16, dark = false) => {
    await command('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await fresh(width, height, touch, 'detail&actionLong&collection' + (dark ? '&siteDark' : ''), false);
    await wait(`document.querySelector('.book-detail-page')?.dataset.navigationLoading==='false'`);
    await evaluate(`document.documentElement.style.fontSize='${font}px';document.fonts.ready.then(()=>true)`); await sleep(220);
  };
  const release = operation => evaluate(`resumeFixture.holdActions.${operation}=false;resumeFixture.pendingActions.filter(r=>r.operation==='${operation}').forEach(r=>r.resolve());resumeFixture.pendingActions=resumeFixture.pendingActions.filter(r=>r.operation!=='${operation}');true`);
  const requests = operation => evaluate(`resumeFixture.actionRequests.filter(r=>r.operation==='${operation}').length`);
  const layouts = process.env.BOOK_ACTION_INTERACTIONS_ONLY ? [] : [
    [1536, 864, false, 16, false, 1], [390, 844, true, 16, true, 1], [768, 1024, true, 16, false, 1],
    [320, 640, true, 32, true, 1], [844, 390, true, 32, false, 1], [320, 280, true, 32, true, 1],
    [1536, 864, false, 32, true, 1], [1536, 864, false, 16, false, 2], [1536, 900, false, 16, true, 1.5], [1536, 900, false, 32, true, 1.5],
  ];
  for (const [width, height, touch, font, dark, scale] of layouts) for (const kind of ['delete', 'replace', 'share']) {
    await reset(width, height < 300 ? 640 : height, touch, font, dark); await open(kind);
    if (kind === 'replace') await file(`new File(['替换正文'],'new_translation_'.repeat(20)+'.txt',{type:'text/plain'})`);
    if (height < 300) { await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch }); await sleep(180); }
    if (scale !== 1) { await command('Emulation.setPageScaleFactor', { pageScaleFactor: scale }); await sleep(220); }
    const label = `${kind} ${width}x${height} font${font} scale${scale} ${dark ? 'dark' : 'light'}`;
    const initial = await snapshot(); observations.push({ label, initial });
    console.log('BOOK_ACTION_OBSERVED', JSON.stringify(observations.at(-1)));
    await screenshot(`book-action-${kind}-${width}-${height}-${font}-${scale}${baseline ? '-baseline' : ''}`);
    if (!baseline) {
      const r = initial.dialog, v = initial.viewport;
      ensure(!initial.overflow && !initial.portalOverflow, label + ' long content fits without horizontal scrolling', initial);
      ensure(r.left >= v.left && r.right <= v.left + v.width + 1 && r.top >= v.top && r.bottom <= v.top + v.height + 1, label + ' dialog fits the visible viewport', initial);
      ensure(initial.close.width === 44 && initial.close.height === 44 && initial.icons.every(i => i.width <= 24 && i.height <= 24), label + ' controls keep compact 44px targets and bounded icons', initial);
      ensure(!initial.filenameClipped && initial.fields.every(f => f.left >= r.left && f.right <= r.right + 1 && (f.type !== 'checkbox' || f.width >= 16)), label + ' full file names and form controls remain readable', initial);
      const last = `Array.from(${dialog}.querySelectorAll('button')).filter(e=>!e.disabled).at(-1)`;
      await evaluate(`${last}.scrollIntoView({block:'center',inline:'nearest'});true`); await sleep(80);
      ensure(await visible(last), label + ' final action is reachable');
      for (let index = 0; index < initial.fields.length; index++) {
        const field = `${dialog}.querySelectorAll('input:not([type=file]),textarea')[${index}]`;
        await evaluate(`${field}.scrollIntoView({block:'center',inline:'nearest'});true`); await sleep(80);
        ensure(await visible(field), label + ' field ' + index + ' can be fully exposed');
      }
      await evaluate(`${dialog}.querySelector('button[aria-label]').focus();true`); await key('Tab', true);
      ensure(await evaluate(`${dialog}.contains(document.activeElement)`) && await visible('document.activeElement'), label + ' Shift Tab reveals its last focus target');
      await key('Tab');
      ensure(await evaluate(`document.activeElement===${dialog}.querySelector('button[aria-label]')`) && await visible('document.activeElement'), label + ' Tab wraps to the visible close action');
      await key('Escape'); await wait(`!${dialog}`);
      ensure(await evaluate(`document.body.style.position!=='fixed'&&document.activeElement?.getAttribute('aria-label')==='更多操作'`), label + ' Escape restores the page and opener');
    }
  }
  await command('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  // Native file selection can suppress change when the same path is picked twice.
  await reset(); await open('replace');
  const reselectPath = path.join(reportDir, 'reselect.txt'); fs.writeFileSync(reselectPath, '第一版正文');
  await command('DOM.enable');
  const documentNode = await command('DOM.getDocument');
  const { nodeId } = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '[role="dialog"] input[type=file]' });
  await evaluate(`window.reselectEvents=0;${dialog}.querySelector('input[type=file]').addEventListener('change',()=>reselectEvents++);true`);
  await command('DOM.setFileInputFiles', { nodeId, files: [reselectPath] }); await sleep(100);
  fs.writeFileSync(reselectPath, '在本地修订后的第二版正文');
  await command('DOM.setFileInputFiles', { nodeId, files: [reselectPath] }); await sleep(100);
  const reselectEvents = await evaluate('reselectEvents');
  console.log('BOOK_ACTION_RESELECT_EVENTS', reselectEvents);
  if (!baseline) ensure(reselectEvents === 2, 'selecting a revised file from the same path fires change again');
  if (!baseline) {
    await pointer(action('确认替换')); await wait(`!${dialog}&&document.body.textContent.includes('替换完成')`);
    ensure(await evaluate(`resumeFixture.actionRequests.at(-1).content==='在本地修订后的第二版正文'&&resumeFixture.actionRequests.at(-1).keepProgress==='true'`), 'same-path reselection uploads revised content and preserves progress by default');
  }
  if (!baseline) {
    for (const [width, height, touch, font, dark] of [[1536, 864, false, 16, false], [320, 640, true, 32, true], [844, 390, true, 32, false]]) {
      const label = `${width}x${height} font${font}`;
      for (const kind of ['delete', 'share', 'replace']) {
        await reset(width, height, touch, font, dark); await open(kind);
        if (kind === 'share') {
          await fill(`${dialog}.querySelectorAll('textarea')[0]`, '保留的推荐理由\n第二行说明');
          await fill(`${dialog}.querySelectorAll('textarea')[1]`, '保留的版本来源');
          await pointer(`${dialog}.querySelector('input[type=checkbox]')`);
        }
        if (kind === 'replace') {
          for (const [code, message] of [[`new File([],'empty.txt')`, '空的'], [`new File(['bad'],'wrong.exe')`, '不支持']]) {
            await file(code); await wait(`${dialog}.querySelector('[role=alert]')?.textContent.includes('${message}')`);
            ensure(await evaluate(`${action('确认替换')}.disabled&&resumeFixture.actionRequests.length===0`), label + ' ' + message + ' file cannot be submitted');
          }
          await file(`new File(['保留的替换正文'],'new_translation_'.repeat(20)+'.txt')`);
          await pointer(`${dialog}.querySelector('input[type=checkbox]')`);
        }
        const labelText = { delete: '确认删除', share: '提交审核', replace: '确认替换' }[kind];
        await evaluate(`resumeFixture.holdActions.${kind}=true;resumeFixture.actionStatus.${kind}=503;window.bookActionSubmit=${action(labelText)};true`);
        await pointer('window.bookActionSubmit'); await wait(`resumeFixture.pendingActions.some(r=>r.operation==='${kind}')`);
        await evaluate('bookActionSubmit.click();bookActionSubmit.click();true'); await key('Escape');
        ensure(await requests(kind) === 1 && await evaluate(`!!${dialog}&&bookActionSubmit.disabled&&[...${dialog}.querySelectorAll('button,input,textarea')].every(e=>e.disabled)`), label + ' pending ' + kind + ' blocks duplicate submission and dismissal');
        if (kind === 'replace') ensure(await evaluate(`${dialog}.querySelector('[role=progressbar]').getAttribute('aria-valuenow')==='34'`), label + ' replacement reports actual upload progress');
        await release(kind); await wait(`!!${dialog}.querySelector('[role=alert]')&&!bookActionSubmit.disabled`);
        const failed = await snapshot();
        ensure(!failed.overflow, label + ' ' + kind + ' wraps a long server error', failed);
        ensure(await evaluate(`getComputedStyle(${dialog}.querySelector('[role=alert]')).whiteSpace==='pre-wrap'`), label + ' ' + kind + ' preserves error line breaks');
        if (kind === 'share') ensure(await evaluate(`${dialog}.querySelectorAll('textarea')[0].value===${JSON.stringify('保留的推荐理由\n第二行说明')}&&${dialog}.querySelectorAll('textarea')[1].value==='保留的版本来源'&&${dialog}.querySelector('input[type=checkbox]').checked`), label + ' failed share keeps both notes and download choice');
        if (kind === 'replace') ensure(await evaluate(`${dialog}.textContent.includes('new_translation_')&&!${dialog}.querySelector('input[type=checkbox]').checked`), label + ' failed replacement keeps the file and progress choice');
        await screenshot('book-action-' + kind + '-failed-' + width);
        await evaluate(`resumeFixture.actionStatus.${kind}=0;true`); await pointer('window.bookActionSubmit');
        await wait(kind === 'delete' ? '!!document.querySelector("#collection-return,.library-page")' : `!${dialog}`);
        ensure(await requests(kind) === 2, label + ' explicit ' + kind + ' retry performs one additional write');
        if (kind === 'delete') ensure(await evaluate(`location.pathname==='/library'&&location.search==='?q=test&sort=recent'`), label + ' delete returns to the original filtered shelf');
        if (kind === 'share') {
          ensure(await evaluate(`resumeFixture.book.public_status==='pending'&&resumeFixture.actionRequests.at(-1).body.share_note===${JSON.stringify('保留的推荐理由\n第二行说明')}&&resumeFixture.actionRequests.at(-1).body.public_download_allowed===true`), label + ' share sends the exact saved draft');
          await pointer(`document.querySelector('[aria-label="更多操作"]')`);
          await pointer(`Array.from(document.querySelectorAll('#book-action-menu button')).find(e=>e.textContent.trim()==='取消审核')`);
          await wait(`resumeFixture.book.public_status==='private'`);
          ensure(await requests('unshare') === 1, label + ' pending share can be withdrawn once');
        }
        if (kind === 'replace') {
          await wait(`document.body.textContent.includes('替换完成')`);
          ensure(await evaluate(`resumeFixture.actionRequests.at(-1).keepProgress==='false'&&resumeFixture.actionRequests.at(-1).content==='保留的替换正文'&&resumeFixture.replacementReads.length>0`), label + ' replacement uploads the retained file and observes the accepted task');
        }
      }
    }
    // Once accepted, an observation failure must never resend the upload.
    for (const outcome of ['failed', 'unconfirmed']) {
      await reset(); await open('replace'); await file(`new File(['实际正文'],'accepted.txt')`);
      await evaluate(`resumeFixture.replacementTaskStatus='${outcome === 'failed' ? 'failed' : 'ready'}';resumeFixture.replacementReadStatus=${outcome === 'failed' ? 0 : 503};true`);
      await pointer(action('确认替换')); await wait(`!${dialog}&&document.body.textContent.includes('${outcome === 'failed' ? '旧版本已保留' : '替换结果暂时无法确认'}')`);
      ensure(await requests('replace') === 1 && await evaluate('resumeFixture.replacementReads.length>0'), outcome + ' accepted replacement retains its outcome and performs only task reads');
      if (outcome === 'unconfirmed') {
        await evaluate(`resumeFixture.replacementReadStatus=0;fixtureNavigate('/library');true`); await wait('!!document.querySelector("#collection-return,.library-page")');
        await evaluate(`fixtureNavigate('/books/resume-test');true`); await wait(`document.body.textContent.includes('替换完成')`);
        ensure(await requests('replace') === 1, 'returning to an unconfirmed replacement resumes GET observation without uploading again');
      }
    }
  }
  fs.writeFileSync(path.join(reportDir, baseline ? 'book-action-baseline.json' : 'book-action-observations.json'), JSON.stringify({ observations, reselectEvents }, null, 2));
}
