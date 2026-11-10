export async function verifyMarkFocusTransitions({ command, ensure, evaluate, fresh, wait, click, reveal, sleep }) {
  const note='document.querySelector("[aria-label=阅读备注]")';
  const refresh='document.querySelector("[aria-label=刷新书签与备注]")';
  const save='Array.from(document.querySelectorAll(".reader-mark-save-actions button")).find(e=>e.textContent.includes("存备注")||e.textContent.includes("保存中"))';
  const activate=async target=>{await evaluate(`(${target}).scrollIntoView({block:'nearest'})`);await click(target);};
  const type=async text=>{await evaluate(`${note}.focus();${note}.select()`);await command('Input.insertText',{text});await sleep(60);};
  const resolve=async operation=>{await evaluate(`resumeFixture.holdMarks.${operation}=false;resumeFixture.pendingMarks.filter(r=>r.operation==='${operation}').forEach(r=>r.resolve());resumeFixture.pendingMarks=resumeFixture.pendingMarks.filter(r=>r.operation!=='${operation}')`);await sleep(140);};
  const enter=async()=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await sleep(50);};
  for(const [width,height,touch] of [[1536,864,false],[390,844,true]]){
    const label=width+' mark actions';
    await fresh(width,height,touch,'theme=dark');await reveal('[aria-label=打开书签与备注]');
    await click('document.querySelector("[aria-label=打开书签与备注]")');await wait('!!document.querySelector(".reader-marks-panel")');await sleep(400);
    await type('第一次提交');await evaluate('resumeFixture.holdMarks.create=true');await activate(save);
    await wait('resumeFixture.pendingMarks.some(r=>r.operation==="create")');await enter();
    ensure(await evaluate('resumeFixture.markRequests.filter(r=>r.operation==="create").length===1'),label+' keyboard activation while saving submits once');
    await type('保存期间继续编辑');await resolve('create');await wait('document.querySelectorAll("[data-reader-mark-id]").length===1');
    ensure(await evaluate(`document.activeElement===${note}&&${note}.value==='保存期间继续编辑'`),label+' a completed save leaves later typing and focus intact');
    await activate(save);await wait('document.querySelectorAll("[data-reader-mark-id]").length===2');
    const id=await evaluate('resumeFixture.marks()[0].id');
    const remove=`Array.from(document.querySelectorAll('[data-reader-mark-id]')).find(e=>e.dataset.readerMarkId===${JSON.stringify(id)}).querySelector('[aria-label^="删除标记"]')`;
    await evaluate('resumeFixture.holdMarks.remove=true;resumeFixture.markStatus.remove=503');await activate(remove);
    await wait('resumeFixture.pendingMarks.some(r=>r.operation==="remove")');await enter();
    ensure(await evaluate(`document.activeElement===${remove}&&resumeFixture.markRequests.filter(r=>r.operation==='remove').length===1`),label+' deletion stays focused and rejects duplicate keyboard activation');
    await resolve('remove');await wait('!!document.querySelector(".reader-mark-compose [role=alert]")');
    ensure(await evaluate(`document.activeElement===${remove}&&document.querySelectorAll('[data-reader-mark-id]').length===2`),label+' failed deletion preserves its row and focused retry');
    await evaluate('resumeFixture.markStatus.remove=0');await activate(remove);await wait('document.querySelectorAll("[data-reader-mark-id]").length===1');await sleep(100);
    ensure(await evaluate('document.activeElement?.hasAttribute("data-reader-mark-jump")'),label+' deleting a row continues at the neighboring note',await evaluate('({focus:document.activeElement?.tagName,rows:Array.from(document.querySelectorAll("[data-reader-mark-id]")).map(e=>({id:e.dataset.readerMarkId,jump:e.querySelector("[data-reader-mark-jump]")?.outerHTML}))})'));
    await evaluate('resumeFixture.holdMarks.load=true;resumeFixture.markStatus.load=503');await activate(refresh);await wait('resumeFixture.pendingMarks.some(r=>r.operation==="load")');
    await type('刷新时继续写');await resolve('load');await wait('!!document.querySelector(".reader-marks-list-region [role=alert]")');
    ensure(await evaluate(`document.activeElement===${note}&&${note}.value==='刷新时继续写'`),label+' a failed refresh does not interrupt later input');
    await evaluate('resumeFixture.markStatus.load=0;resumeFixture.marks()[0].position_valid=false');await activate(refresh);await wait('document.querySelector("[data-reader-mark-jump]")?.disabled');
    const relocate='Array.from(document.querySelectorAll(".reader-mark-item button")).find(e=>e.textContent.includes("定位到当前"))';
    await evaluate('resumeFixture.holdMarks.relocate=true');await activate(relocate);await wait('resumeFixture.pendingMarks.some(r=>r.operation==="relocate")');
    await type('重新定位期间的新草稿');await resolve('relocate');await wait('document.querySelector("[data-reader-mark-jump]")?.disabled===false');
    ensure(await evaluate(`document.activeElement===${note}&&${note}.value==='重新定位期间的新草稿'`),label+' successful relocation cannot steal focus from later writing');
    await evaluate('resumeFixture.holdMarks.remove=true');await activate('document.querySelector("[aria-label^=删除标记]")');await wait('resumeFixture.pendingMarks.some(r=>r.operation==="remove")');
    await type('删除期间继续编辑');await resolve('remove');await wait('!document.querySelector("[data-reader-mark-id]")');
    ensure(await evaluate(`document.activeElement===${note}&&${note}.value==='删除期间继续编辑'`),label+' successful deletion preserves later typing and focus');
    await activate(save);await wait('document.querySelectorAll("[data-reader-mark-id]").length===1');
    await activate('document.querySelector("[aria-label^=删除标记]")');await wait('!document.querySelector("[data-reader-mark-id]")');await sleep(100);
    ensure(await evaluate(`document.activeElement===${refresh}`),label+' deleting the final note returns focus to the panel action');
    await evaluate('resumeFixture.holdMarks.load=true');await activate(refresh);await wait('resumeFixture.pendingMarks.some(r=>r.operation==="load")');
    await click('document.querySelector("[aria-label=关闭书签与备注]")');await resolve('load');
    ensure(await evaluate('!document.querySelector(".reader-marks-panel")&&document.activeElement?.getAttribute("aria-label")==="打开书签与备注"'),label+' a late refresh leaves a closed panel closed and its opener focused');
  }
}
