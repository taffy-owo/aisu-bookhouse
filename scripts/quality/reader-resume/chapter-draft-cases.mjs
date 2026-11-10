/** Exercise actual editors through dismissal, route changes and full document reloads. */
export async function verifyChapterDrafts({ command, ensure, evaluate, fresh, ready, wait, click, reveal, select, sleep, screenshot }) {
  const dialog = 'document.querySelector("[role=dialog]")';
  const textarea = dialog + '.querySelector("textarea")';
  const title = dialog + '.querySelector("input")';
  const fill = async (target, text) => { await evaluate(target+'.focus();'+target+'.select()'); await command('Input.insertText', { text }); };
  const detailReady = () => wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false" && document.querySelectorAll(".book-detail-catalog-content a").length>=3');
  const open = async (surface, operation) => {
    if (surface === 'detail') {
      await detailReady();
      const trigger = operation === 'append' ? 'Array.from(document.querySelectorAll(".book-detail-actions button")).find(e=>e.textContent.trim()==="追加章节")' : 'document.querySelectorAll(".book-detail-catalog-content button[aria-label^=编辑]")[1]';
      await evaluate(trigger+'.scrollIntoView({block:"center"})'); await sleep(90); await click(trigger);
    } else {
      await reveal('[aria-label=编辑本章]'); await click('document.querySelector("[aria-label=编辑本章]")');
    }
    await wait('!!'+dialog+'?.querySelector("textarea")');
  };
  const close = async operation => { await click('document.querySelector("[aria-label=关闭'+(operation==='append'?'追加章节':'章节编辑')+']")'); await wait('!'+dialog); };
  const submit = operation => operation === 'append' ? 'Array.from('+dialog+'.querySelectorAll("button")).at(-1)' : 'document.querySelector(".chapter-editor-save")';
  const reload = async surface => { await command('Page.reload'); if(surface==='detail') await detailReady(); else await ready(2); };
  const checkDraft = (body, name) => evaluate(textarea+'.value==='+JSON.stringify(body)+'&&'+title+'.value==='+JSON.stringify(name));

  for (const [width,height,touch] of [[390,844,true],[768,1024,true],[1536,864,false]]) {
    for (const [surface,operation] of [['reader','save'],['detail','save'],['detail','append']]) {
      const label=`${width} ${surface} ${operation}`;
      await fresh(width,height,touch,'persistEditor&'+(surface==='detail'?'detail&siteDark':'theme=dark'),surface!=='detail');
      if(surface==='reader') { await select(2); await ready(2); }
      await open(surface,operation);
      const body='第一段未完成的正文。\n\n第3章 这是正文中的一句话。\n\n最后一个字。',name='第2话 草稿';
      await fill(textarea,body); await fill(title,name);
      await close(operation); await open(surface,operation);
      ensure(await checkDraft(body,name),label+' dismissal and reopening preserves the complete title and last character');
      await fill(textarea,body+'刷新前最后输入');
      await reload(surface); await open(surface,operation);
      ensure(await checkDraft(body+'刷新前最后输入',name),label+' immediate full reload flushes pending input and restores the draft');
      ensure(await evaluate('document.documentElement.scrollWidth<=innerWidth+1 && '+dialog+'.textContent.includes("草稿")'),label+' restored draft status fits the viewport');
      await evaluate(submit(operation)+'.scrollIntoView({block:"center"})'); await sleep(70);
      ensure(await evaluate(`(()=>{const e=${submit(operation)},r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`),label+' save remains visible and tappable with draft recovery information');
      await screenshot('chapter-draft-'+width+'-'+surface+'-'+operation);
      await click(submit(operation)); await wait('!'+dialog);
      if(surface==='detail') await detailReady();
      await open(surface,operation);
      ensure(await evaluate(operation==='append'?textarea+'.value===""&&'+title+'.value===""':textarea+'.value==='+JSON.stringify(body+'刷新前最后输入')+'&&!'+dialog+'.textContent.includes("草稿已暂存")'),label+' confirmed success clears the draft without changing confirmed server content');
    }
  }
  for(const [surface,operation] of [['reader','save'],['detail','save'],['detail','append']]) for(const committed of [false,true]) {
    const label=surface+' '+operation+' '+(committed?'lost acknowledgement':'before commit');
    await fresh(768,1024,true,'persistEditor&'+(surface==='detail'?'detail&siteDark':'theme=dark'),surface!=='detail');
    if(surface==='reader') {await select(2);await ready(2);}
    await open(surface,operation);await fill(textarea,'刷新后继续核对的正文。');
    await evaluate('resumeFixture.editorStatus.'+operation+'='+(committed?-2:-1));await click(submit(operation));
    await wait(dialog+'?.querySelector("[role=alert]")?.textContent.includes("结果未确认")');
    const first=await evaluate('resumeFixture.editorRequests.find(r=>r.operation==='+JSON.stringify(operation)+')');
    await reload(surface);await open(surface,operation);
    ensure(await evaluate(textarea+'.value==="刷新后继续核对的正文。"'),label+' restores the uncertain edit after a real reload');
    if(committed&&operation==='save') ensure(await evaluate('document.querySelector(".chapter-editor-delete").disabled&&'+dialog+'.textContent.includes("旧版本草稿")'),label+' old draft is identified and cannot delete the newly loaded chapter');
    await click(submit(operation));await wait('!'+dialog);
    ensure(await evaluate(`(()=>{const requests=resumeFixture.editorRequests.filter(r=>r.operation===${JSON.stringify(operation)});return requests.length===2&&requests[1].revision===${JSON.stringify(first.revision)}&&requests[1].requestId===${JSON.stringify(first.requestId)}&&resumeFixture.editorReceipts.size===1&&resumeFixture.resource.chapter_count===${operation==='append'?4:3}})()`),label+' restored editor reuses its original revision and request receipt');
  }
  // An external update must remain intact even after closing the stale editor.
  await fresh(768,1024,true,'detail&siteDark&persistEditor',false);await open('detail','save');
  await fill(textarea,'需要保留并人工核对的草稿。');await close('save');
  await evaluate('resumeFixture.chapterEdits.set(2,{content:"其他窗口更新后的正文。",title:"第2话"})');await open('detail','save');
  ensure(await evaluate(textarea+'.value==="需要保留并人工核对的草稿。"&&document.querySelector(".chapter-editor-delete").disabled'),'external change never replaces or silently rebases the recovered draft');
  await click(submit('save'));await wait(dialog+'?.querySelector("[role=alert]")?.textContent.includes("本次操作未执行")');
  ensure(await evaluate('resumeFixture.chapterEdits.get(2).content==="其他窗口更新后的正文。"&&'+textarea+'.value==="需要保留并人工核对的草稿。"'),'stale draft save explicitly preserves both user input and server changes');
  await evaluate('window.confirm=()=>true');await click('Array.from('+dialog+'.querySelectorAll("button")).find(e=>e.textContent.includes("丢弃草稿"))');
  ensure(await evaluate(textarea+'.value==="其他窗口更新后的正文。"&&!document.querySelector(".chapter-editor-delete").disabled&&!'+dialog+'.querySelector("[role=alert]")&&document.activeElement==='+textarea),'explicit discard loads the current version, clears the obsolete conflict and returns focus to prose');
  await fill(textarea,'账号切换前最后输入。');
  await evaluate('resumeFixture.switchAccount("draft-next-user")');await detailReady();await open('detail','save');
  ensure(await evaluate(textarea+'.value==="其他窗口更新后的正文。"'),'account changes never expose another account\'s draft');
  await close('save');await evaluate('resumeFixture.switchAccount("resume-test-user")');await detailReady();await open('detail','save');
  ensure(await evaluate(textarea+'.value==="账号切换前最后输入。"'),'returning to the original account restores its own pending draft');
  // Storage errors must be visible and recoverable without replacing in-memory input.
  await evaluate(`window.nativeDraftSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('aisu-bookhouse:chapter-draft:'))throw Error('quota');return nativeDraftSet.call(this,key,value)}`);
  await fill(textarea,'存储暂时不可用时的输入。');await sleep(420);
  ensure(await evaluate(dialog+'.textContent.includes("刷新或关闭前请先复制正文")&&'+textarea+'.value==="存储暂时不可用时的输入。"'),'storage failure warns before refresh and retains editable text');
  await close('save');await open('detail','save');
  ensure(await evaluate(textarea+'.value==="存储暂时不可用时的输入。"'),'failed storage still retains the latest draft when the dialog is reopened');
  await evaluate('Storage.prototype.setItem=nativeDraftSet');await click('Array.from('+dialog+'.querySelectorAll("button")).find(e=>e.textContent==="重试保存")');
  await reload('detail');await open('detail','save');
  ensure(await evaluate(textarea+'.value==="存储暂时不可用时的输入。"'),'storage retry persists the latest memory draft through a full reload');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:340,deviceScaleFactor:1,mobile:true});await sleep(200);
  await evaluate(submit('save')+'.scrollIntoView({block:"center"})');await sleep(120);
  ensure(await evaluate(`(()=>{const e=${submit('save')},r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`),'short keyboard viewport can still reach the save action');
  await fresh(390,844,true,'detail&siteDark&persistEditor',false);await open('detail','append');
  const pastedText = '第4章 新章\n第5章 这是正文的一句话。\n其后的正文不能被再次识别为章节名。';
  await evaluate(`(()=>{const data=new DataTransfer();data.setData('text',${JSON.stringify(pastedText)});${textarea}.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))})()`);
  await wait(title+'.value==="第4章 新章"');
  const prepared=await evaluate(textarea+'.value');
  await reload('detail');await open('detail','append');
  ensure(await checkDraft(prepared,'第4章 新章'),'reload preserves automatic title extraction and the already prepared body');
  await click(submit('append'));await wait('!'+dialog);
  ensure(await evaluate('resumeFixture.chapterEdits.get(4).content.startsWith("第5章 这是正文的一句话。")'),'restored prepared append never removes a chapter-like first paragraph a second time');
}
