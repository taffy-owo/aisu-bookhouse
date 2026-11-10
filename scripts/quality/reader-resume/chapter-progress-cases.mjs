export async function verifyChapterProgress({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot }) {
  const percent = 'document.querySelector(".book-detail-progress [role=progressbar]")?.getAttribute("aria-valuenow")';
  const active = 'document.querySelector(".book-detail-catalog-content [aria-current=page]")';
  const dialog = 'document.querySelector("[role=dialog]")';
  const tap = async target => { await evaluate(target + '.scrollIntoView({block:"center"})'); await sleep(80); await click(target); };
  for (const [width, height, touch] of [[1536, 864, false], [768, 1024, true], [390, 844, true]]) {
    for (const [operation, index, expected, title, ratio] of [
      ['remove', 1, 67, '第2话', .75], ['remove', 2, 33, '第3话', 0], ['remove', 3, 72, '第2话', .75],
      ['remove', 4, 100, '第3话', 1], ['save', 1, 79, '第2话', .75],
    ]) {
      const label = `${width} ${operation} chapter ${index}`;
      await fresh(width, height, touch, 'detail&siteDark&catalogLength=4&catalogMutationProgress=' + (index === 4 ? 'last' : 'middle'), false);
      await wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false" && !!' + active);
      const initialTime = await evaluate('resumeFixture.progress().updated_at');
      await tap(`document.querySelectorAll('.book-detail-catalog-content button[aria-label^=编辑]')[${index - 1}]`);
      await wait('!!' + dialog + '?.querySelector("textarea")');
      if (operation === 'save') {
        await evaluate(dialog + '.querySelector("textarea").focus();' + dialog + '.querySelector("textarea").select()');
        await command('Input.insertText', { text: '修'.repeat(1000) });
      } else await evaluate('window.confirm=()=>true');
      await tap(operation === 'save' ? 'document.querySelector(".chapter-editor-save")' : 'Array.from(' + dialog + '.querySelectorAll("button")).find(e=>e.textContent.trim()==="删除本话")');
      await wait('!' + dialog + ' && ' + percent + '==="' + expected + '" && ' + active + '?.textContent.includes(' + JSON.stringify(title) + ')');
      ensure(await evaluate(percent + '==="' + expected + '" && resumeFixture.progress().updated_at===' + JSON.stringify(initialTime)), label + ' coherent detail refresh keeps weighted progress and actual reading time');
      ensure(await evaluate('resumeFixture.editorRequests.filter(r=>r.operation===' + JSON.stringify(operation) + ').length===1'), label + ' applies exactly one chapter mutation');
      ensure(await evaluate('document.querySelectorAll(".book-detail-catalog-content a").length===' + (operation === 'save' ? 4 : 3)), label + ' keeps the current catalog length');
      await wait('(()=>{const track=document.querySelector(".book-detail-progress [role=progressbar]"),fill=track?.firstElementChild;return track && fill && Math.abs(fill.getBoundingClientRect().width/track.getBoundingClientRect().width*100-' + expected + ')<.5})()');
      ensure(true, label + ' visible progress bar settles at the displayed percentage');
      if (width === 1536 && operation === 'remove' && index === 2) await screenshot('chapter-progress-current-deleted');
      const resume = 'Array.from(document.querySelectorAll(".book-detail-page a")).find(e=>e.textContent.includes("继续阅读") && e.getBoundingClientRect().height>0)';
      await tap(resume);
      await wait('document.querySelector(".reader-chapter-heading h1")?.textContent===' + JSON.stringify(title) + ' && document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');
      ensure(await evaluate('document.querySelector(".reader-chapter-heading h1").textContent===' + JSON.stringify(title)), label + ' resumes the retained chapter or the deleted chapter neighbor');
      await wait('(()=>{const e=document.querySelector(".reader-document-scroll")?document.scrollingElement:document.querySelector(".reader-viewport");return e && Math.abs(e.scrollTop/(e.scrollHeight-e.clientHeight)-' + ratio + ')<.04})()');
      ensure(true, label + ' restores the intended offset including start and end boundaries');
    }
    for (const [index, title, expected, ratio] of [[2, '第3话', 33, 0], [4, '第3话', 100, 1]]) {
      const label = `${width} reader removes current chapter ${index}`;
      await fresh(width, height, touch, 'siteDark&theme=dark&catalogLength=4&catalogMutationProgress=' + (index === 4 ? 'last' : 'middle'), false);
      await wait('document.querySelector(".reader-chapter-heading h1")?.textContent==="第' + index + '话" && document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');
      const editor = 'document.querySelector("[aria-label=编辑本章]")';
      if (await evaluate('!!' + editor + '?.closest("[inert]")')) {
        const point = await evaluate('({x:innerWidth/2,y:innerHeight/2})');
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      }
      await wait('!!' + editor + ' && !' + editor + '.closest("[inert]")');
      await tap(editor); await wait('!!' + dialog + '?.querySelector("textarea")');
      await evaluate('window.confirm=()=>true');
      await tap('Array.from(' + dialog + '.querySelectorAll("button")).find(e=>e.textContent.trim()==="删除本话")');
      await wait('!' + dialog + ' && document.querySelector(".reader-chapter-heading h1")?.textContent===' + JSON.stringify(title) + ' && document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');
      ensure(await evaluate('resumeFixture.editorRequests.filter(r=>r.operation==="remove").length===1 && resumeFixture.resource.toc.length===3'), label + ' publishes one deletion and loads the new neighbor');
      await wait('(()=>{const e=document.querySelector(".reader-document-scroll")?document.scrollingElement:document.querySelector(".reader-viewport");return e && Math.abs(e.scrollTop/(e.scrollHeight-e.clientHeight)-' + ratio + ')<.04})()');
      await wait('resumeFixture.progress().progress_percent===' + expected);
      ensure(true, label + ' preserves the correct boundary and weighted percentage inside the reader');
      ensure(await evaluate('resumeFixture.attempts.every(write=>!write.position_key || resumeFixture.resource.toc.some(item=>item.position_key===write.position_key))'), label + ' does not save a position for the deleted chapter');
    }
  }
}
