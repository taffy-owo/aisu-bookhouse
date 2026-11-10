export async function verifyMarkUpdates({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot }) {
  const control='document.querySelector("[aria-label=打开书签与备注]")';
  const note='document.querySelector("[aria-label=阅读备注]")';
  const save='Array.from(document.querySelectorAll(".reader-mark-save-actions button")).find(e=>e.textContent.includes("存备注"))';
  const bookmark='Array.from(document.querySelectorAll(".reader-mark-save-actions button")).find(e=>e.textContent.includes("加书签"))';
  const row=id=>'document.querySelector('+JSON.stringify('[data-reader-mark-id="'+id+'"]')+')';
  const activate=async expression=>{
    await evaluate('('+expression+').scrollIntoView({block:"center",behavior:"instant"})');
    await wait('(()=>{const e='+expression+',r=e.getBoundingClientRect();return r.width>0 && r.height>0 && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()');
    await click(expression);
  };
  const open=async()=>{
    if(await evaluate('!!document.querySelector(".reader-marks-panel")'))return;
    if(!await evaluate('!!'+control)){
      const tools='document.querySelector("[aria-label=更多阅读工具]")';await wait('!!'+tools);
      if(await evaluate('!!'+tools+'.closest("[inert]")')){
        const point=await evaluate('(()=>{const r=document.querySelector(".pdf-reader-scroll").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
        await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      }
      await wait('!'+tools+'.closest("[inert]")');await activate(tools);
    }
    await wait('!!'+control);
    if(await evaluate('!!'+control+'.closest("[inert]")')){
      const point=await evaluate('({x:innerWidth/2,y:innerHeight/2})');
      await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
    await wait('!'+control+'.closest("[inert]")');await activate(control);await wait('!!'+note);
  };
  for(const [width,height,touch] of [[1536,864,false],[768,1024,true],[390,844,true]]){
    for(const format of ['epub','comic','image','pdf']){
      const query=format==='comic'?'readableManga':format==='image'?'readableImage':format==='pdf'?'pdf&pdfPages=3':'';
      const label=width+' '+format+' updated-file notes';
      await fresh(width,height,touch,query+'&theme=dark',false);
      if(format==='pdf')await wait('!!document.querySelector(".pdf-canvas-page canvas,.pdf-reflow-text")');
      else await wait('!!'+control);
      const ids=await evaluate(`(async()=>{
        const position=${JSON.stringify(format==='epub'?{chapter_index:1,epub_cfi:'aisu-scroll:0.25',position_key:'key-1'}:format==='pdf'?{page_number:1,position_key:'fixture-pdf'}:{image_index:1,page_number:1,position_key:'image-1'})};
        const seed=async extra=>await(await fetch('/api/v1/books/resume-test/marks',{method:'POST',body:JSON.stringify({reader_type:${JSON.stringify(format)},kind:'note',label:'保留的旁注',note:'已有备注也要保留',progress_percent:12,...position,...extra})})).json();
        return{valid:(await seed({})).id,lost:(await seed({position_key:'missing'})).id};
      })()`);
      await open();await evaluate(note+'.focus()');await command('Input.insertText',{text:'更新时也不能丢失的草稿'});
      await evaluate(`(()=>{
        const r=resumeFixture.resource,p=resumeFixture.progress();r.version='2026-11-05T00:00:00Z';resumeFixture.book.updated_at=r.version;
        if(r.reader_type==='epub'){
          r.reader_type=resumeFixture.book.reader_type=p.reader_type='text';
          r.toc.forEach((item,i)=>{item.position_key='new-key-'+(i+1);resumeFixture.chapterEdits.set(i+1,{position_key:item.position_key});});
          p.position_key='new-key-1';
}else if(r.reader_type==='pdf'){r.position_key='new-pdf';p.position_key='new-pdf';}
        else{r.pages.forEach((item,i)=>{item.position_key='new-image-'+(i+1);});p.position_key='new-image-1';}
        window.dispatchEvent(new Event('focus'));
      })()`);
      await wait('!!document.querySelector(".reader-marks-position-recovery")');
      const before=await evaluate('({requests:resumeFixture.markRequests.length,writes:resumeFixture.writes.length})');
      ensure(await evaluate(save+'.getAttribute("aria-disabled")==="true" && '+bookmark+'.getAttribute("aria-disabled")==="true"'),label+' disables saves before an obsolete position can be submitted');
      ensure(await evaluate(row(ids.valid)+'.querySelector("[data-reader-mark-jump]").disabled'),label+' disables jumps against the old file');
      const relocate='Array.from('+row(ids.lost)+'.querySelectorAll("button")).find(e=>e.textContent.includes("定位到当前"))';
      ensure(await evaluate(relocate+'.getAttribute("aria-disabled")==="true"'),label+' disables relocation into the old file');
      await activate(save);await activate(relocate);await sleep(150);
      ensure(await evaluate('resumeFixture.markRequests.length==='+before.requests+' && resumeFixture.writes.length==='+before.writes),label+' disabled actions issue no mark or progress writes');
      await evaluate(note+'.focus()');await command('Input.insertText',{text:'，还可以继续编辑'});
      const draft=await evaluate(note+'.value');
      const origin=await evaluate('JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k=>k.startsWith("aisu:reader-note-draft:")))).origin');
      await activate(row(ids.lost)+'.querySelector("[aria-label^=删除标记]")');
      await wait('!'+row(ids.lost));
      ensure(await evaluate(note+'.value==='+JSON.stringify(draft)+' && !!'+row(ids.valid)),label+' deletion remains usable and keeps the draft and other note');
      const load='document.querySelector("[data-reader-mark-load-edition]")';
      await evaluate('resumeFixture.startupStatus=503');await activate(load);
      await wait('!!document.querySelector(".reader-marks-position-recovery [role=alert]")');
      ensure(await evaluate(note+'.value==='+JSON.stringify(draft)+' && !!document.querySelector(".reader-marks-panel") && '+load+'.getAttribute("aria-disabled")!=="true"'),label+' failed update preserves the open panel and editable draft with retry');
      ensure(await evaluate('JSON.stringify(JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k=>k.startsWith("aisu:reader-note-draft:")))).origin)==='+JSON.stringify(JSON.stringify(origin))),label+' failed update does not silently reassign the draft position');
      await screenshot('mark-update-failed-'+format+'-'+width);
      const requests=await evaluate('resumeFixture.startupRequests.length');
      await evaluate('resumeFixture.startupStatus=0;resumeFixture.holdStartup=true');await activate(load);
      await wait(load+'.getAttribute("aria-disabled")==="true" && resumeFixture.pendingStartups.length>0');
      await activate(load);await sleep(120);
      ensure(await evaluate('resumeFixture.startupRequests.length==='+String(requests+1)+' && '+note+'.value==='+JSON.stringify(draft)),label+' repeated update clicks share one pending load and retain the draft');
      await evaluate('resumeFixture.holdStartup=false;resumeFixture.pendingStartups.splice(0).forEach(resolve=>resolve())');
      await wait('!document.querySelector(".reader-marks-position-recovery")');
      await open();
      ensure(await evaluate(note+'.value==='+JSON.stringify(draft)),label+' loading the new edition keeps the unsaved draft');
      const adopt='Array.from(document.querySelectorAll(".reader-mark-compose button")).find(e=>e.textContent.includes("改存到当前位置"))';
      const count=await evaluate('resumeFixture.marks().length');
      await wait('!!'+adopt);await activate(adopt);await activate(save);
      await wait('resumeFixture.marks().some(m=>m.note==='+JSON.stringify(draft)+')');
      ensure(await evaluate('(()=>{const m=resumeFixture.marks().find(m=>m.note==='+JSON.stringify(draft)+');return resumeFixture.marks().length==='+String(count+1)+' && m.position_key.startsWith("new-") && m.reader_type==='+JSON.stringify(format==='epub'?'text':format)+'})()'),label+' explicit adoption saves once at a current edition position');
    }
  }
}
