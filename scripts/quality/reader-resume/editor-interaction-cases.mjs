/** Draft actions must leave a coherent form and usable native focus. */
export async function verifyEditorInteractions({ command, ensure, evaluate, fresh, ready, wait, click, reveal, select, sleep, screenshot }) {
  const dialog = 'document.querySelector("[role=dialog]")';
  const body = dialog + '.querySelector("textarea")';
  const discard = 'Array.from('+dialog+'.querySelectorAll("button")).find(e=>e.textContent.includes("丢弃草稿"))';
  const retry = 'Array.from('+dialog+'.querySelectorAll("button")).find(e=>/^重试/.test(e.textContent))';
  const fill = async text => { await evaluate(body+'.focus();'+body+'.select()'); await command('Input.insertText',{text}); };
  const tap = async target => { await evaluate(target+'.scrollIntoView({block:"center"})');await sleep(100);await click(target); };
  const submit = operation => operation==='append' ? 'Array.from('+dialog+'.querySelectorAll("button")).at(-1)' : 'document.querySelector(".chapter-editor-save")';
  const open = async (surface,operation,width,height,touch) => {
    await fresh(width,height,touch,'persistEditor&'+(surface==='detail'?'detail&siteDark':'theme=dark'),surface!=='detail');
    if(surface==='detail') {
      await wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false"&&document.querySelectorAll(".book-detail-catalog-content a").length===3');
      const trigger=operation==='append'?'Array.from(document.querySelectorAll(".book-detail-actions button")).find(e=>e.textContent.trim()==="追加章节")':'document.querySelectorAll(".book-detail-catalog-content button[aria-label^=编辑]")[1]';
      await tap(trigger);
    } else {await select(2);await ready(2);await reveal('[aria-label=编辑本章]');await click('document.querySelector("[aria-label=编辑本章]")');}
    await wait('!!'+dialog+'?.querySelector("textarea")');
  };
  for(const [width,height,touch] of [[1536,864,false],[390,844,true],[768,1024,true]]) for(const [surface,operation] of [['detail','save'],['reader','save'],['detail','append']]) {
    const label=`${width} ${surface} ${operation}`;
    await open(surface,operation,width,height,touch);
    if(touch) ensure(await evaluate('parseFloat(getComputedStyle('+dialog+'.querySelector("input")).fontSize)>=16&&Array.from('+dialog+'.querySelectorAll("button")).every(e=>e.getBoundingClientRect().height>=44)'),label+' touch inputs use readable text and full-size hit targets');
    const original=await evaluate(body+'.value');
    await fill('准备丢弃的未保存正文。');
    await evaluate(`resumeFixture.editorStatus.${operation}=422;resumeFixture.editorMessage='本次内容被拒绝，请核对。'`);
    await tap(submit(operation));await wait(dialog+'?.querySelector("[role=alert]")?.textContent.includes("内容被拒绝")');
    await evaluate('window.confirm=()=>false');await tap(discard);
    ensure(await evaluate(body+'.value==="准备丢弃的未保存正文。"&&!!'+dialog+'.querySelector("[role=alert]")&&document.activeElement==='+discard),label+' cancelling discard preserves the draft, rejection and focused action');
    await evaluate('window.confirm=()=>true');await tap(discard);
    ensure(await evaluate(body+'.value==='+JSON.stringify(original)+'&&!'+dialog+'.querySelector("[role=alert]")&&document.activeElement==='+body),label+' confirmed discard resets obsolete errors and returns focus to prose');
    await command('Input.insertText',{text:'焦点仍可直接输入。'});
    ensure(await evaluate(body+'.value.includes("焦点仍可直接输入。")&&resumeFixture.editorRequests.filter(r=>r.operation==="'+operation+'").length===1'),label+' typing after discard edits only the current form without submitting a write');
    await evaluate(`window.originalDraftSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('aisu-bookhouse:chapter-draft:'))throw Error('quota');return originalDraftSet.call(this,k,v)}`);
    await fill('存储失败后继续编辑。');await sleep(450);await wait('!!'+retry);
    await tap(retry);
    ensure(await evaluate('document.activeElement==='+retry+'&&'+body+'.value==="存储失败后继续编辑。"'),label+' failed persistence retry keeps focus on its available action and retains input');
    await evaluate('Storage.prototype.setItem=originalDraftSet');await tap(retry);
    ensure(await evaluate('document.activeElement==='+body+'&&!'+retry+'&&'+body+'.value==="存储失败后继续编辑。"'),label+' successful persistence retry returns focus when its action disappears');
    await evaluate(`window.originalDraftRemove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(k.startsWith('aisu-bookhouse:chapter-draft:'))throw Error('blocked');return originalDraftRemove.call(this,k)}`);
    await tap(discard);
    ensure(await evaluate(body+'.value==='+JSON.stringify(original)+'&&'+retry+'.textContent==="重试清理"&&document.activeElement==='+body),label+' failed draft cleanup shows the matching action without restoring discarded text');
    await evaluate('Storage.prototype.removeItem=originalDraftRemove');await tap(retry);
    ensure(await evaluate('!'+retry+'&&document.activeElement==='+body+'&&'+body+'.value==='+JSON.stringify(original)),label+' cleanup retry removes only the old stored copy and returns native input focus');
  }
  await open('detail','append',390,844,true);await fill('之前暂存、稍后重试读取的草稿。');await sleep(450);
  await evaluate('sessionStorage.setItem("block-next-draft-read","true")');
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`if(location.protocol==='http:'&&sessionStorage.getItem('block-next-draft-read')==='true'){sessionStorage.removeItem('block-next-draft-read');window.originalDraftGet=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k.startsWith('aisu-bookhouse:chapter-draft:'))throw Error('unavailable');return originalDraftGet.call(this,k)}}`});
  await command('Page.reload');
  await wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false"');
  await tap('Array.from(document.querySelectorAll(".book-detail-actions button")).find(e=>e.textContent.trim()==="追加章节")');await wait('!!'+retry);
  ensure(await evaluate(retry+'.textContent==="重试读取"&&'+body+'.value===""'),'failed initial read exposes its matching retry without discarding the stored draft');
  await evaluate('Storage.prototype.getItem=originalDraftGet');await tap(retry);
  ensure(await evaluate(body+'.value==="之前暂存、稍后重试读取的草稿。"&&document.activeElement==='+body+'&&!'+retry),'successful read retry restores the original draft and focuses prose');

  for(const [surface,operation] of [['detail','save'],['reader','save'],['detail','append']]) {
    const label=`compact ${surface} ${operation}`;
    await open(surface,operation,390,844,true);await fill('键盘弹出后的完整正文。');
    await evaluate(`resumeFixture.editorStatus.${operation}=422;resumeFixture.editorMessage='需要核对的保存错误。'.repeat(16)`);await tap(submit(operation));await wait('!!'+dialog+'.querySelector("[role=alert]")');
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:320,deviceScaleFactor:1,mobile:true});await sleep(220);
    const snapshot=await evaluate(`(()=>{const form=${dialog},fields=form.querySelector('.chapter-editor-fields');return {overflow:getComputedStyle(form).overflowY,height:fields?.getBoundingClientRect().height??form.scrollHeight,width:document.documentElement.scrollWidth}})()`);
    ensure(snapshot.overflow==='auto'&&snapshot.height>220&&snapshot.width<=391,label+' keyboard viewport retains a scrollable complete form instead of collapsing the body');
    for(const target of [body,submit(operation),'document.querySelector("[aria-label=关闭'+(operation==='append'?'追加章节':'章节编辑')+']")']) {
      await evaluate(target+'.scrollIntoView({block:"center"})');await sleep(80);
      ensure(await evaluate(`(()=>{const e=${target},r=e.getBoundingClientRect(),y=Math.max(1,Math.min(innerHeight-1,r.top+r.height/2));return r.bottom>0&&r.top<innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,y))})()`),label+' prose, submit and exit remain reachable');
    }
    await screenshot('editor-interaction-compact-'+surface+'-'+operation);
  }
}
