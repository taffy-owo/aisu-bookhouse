export async function verifyChapterUpdates({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot }) {
  const scroller='(document.querySelector(".reader-document-scroll")?document.scrollingElement:document.querySelector(".reader-viewport"))';
  const action='document.querySelector('+JSON.stringify('[aria-label="本话已更新，加载新版正文"]')+')';
  const note='document.querySelector("[aria-label=阅读备注]")';
  const save='Array.from(document.querySelectorAll(".reader-mark-save-actions button")).find(e=>e.textContent.includes("存备注"))';
  const anchor=()=>evaluate('(()=>{const e='+scroller+',top=e===document.scrollingElement?80:e.getBoundingClientRect().top+80,p=[...document.querySelectorAll(".reader-body-text p")].find(p=>p.getBoundingClientRect().bottom>top);if(!p)return{};const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),range=document.createRange();let node;while((node=walker.nextNode())){if(node.parentElement.closest("rt,rp"))continue;for(let i=0;i<node.length;i++){range.setStart(node,i);range.setEnd(node,i+1);const rect=range.getBoundingClientRect();if(rect.bottom>top)return{text:p.textContent,snippet:node.data.slice(i,i+24),y:rect.top,scroll:e.scrollTop};}}return{}})()');
  const pinned=before=>evaluate('(()=>{const before='+JSON.stringify(before)+',p=[...document.querySelectorAll(".reader-body-text p")].find(p=>p.textContent.endsWith(before.text));if(!p)return{};const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),range=document.createRange();let node;while((node=walker.nextNode())){const i=node.data.indexOf(before.snippet);if(i<0)continue;range.setStart(node,i);range.setEnd(node,i+1);return{snippet:before.snippet,y:range.getBoundingClientRect().top};}return{}})()');
  const activate=async expression=>{
    await evaluate('('+expression+').scrollIntoView({block:"nearest",behavior:"instant"})');
    await wait('(()=>{const e='+expression+',r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()');
    await click(expression);
  };
  const reveal=async()=>{
    const control='('+action+' || document.querySelector("[aria-label=打开书签与备注]"))';
    if(!await evaluate('!!'+control+'?.closest("[inert]")'))return;
    const point=await evaluate('({x:innerWidth/2,y:innerHeight/2})');
    await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    await wait('!'+control+'?.closest("[inert]")');await sleep(550);
  };
  const update=async revised=>{
    await evaluate('(()=>{resumeFixture.chapterEdits.set(1,'+JSON.stringify(revised)+');resumeFixture.resource.toc[0].content_version="updated-1";resumeFixture.resource.version="2026-11-07T00:00:00Z";window.dispatchEvent(new Event("focus"));})()');
    await wait('!!'+action+' || !!document.querySelector(".reader-marks-position-recovery")');
  };
  const ready=()=>wait('document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');
  const openMarks=async()=>{
    await reveal();await activate('document.querySelector("[aria-label=打开书签与备注]")');await wait('!!'+note);
  };
  for(const [width,height,touch] of [[1536,864,false],[768,1024,true],[390,844,true]]){
    for(const operation of ['prepend','trim','inline','title','start','end','notes','failure','navigation','stale','paged']){
      const label=width+' external chapter '+operation;
      await fresh(width,height,touch,'chapterUpdates&theme=dark'+(operation==='paged'?'&paged':''));await ready();
      const original=await evaluate('(async()=>await(await fetch("/api/v1/books/resume-test/reader/chapters/1")).json())()');
      await evaluate(scroller+'.scrollTop='+(operation==='start'?0:operation==='end'?1e9:4000));await sleep(650);
      const before=await anchor(),oldText=await evaluate('document.querySelector(".reader-body-text").textContent');
      if(operation==='notes'){
        await openMarks();await evaluate(note+'.focus()');await command('Input.insertText',{text:'正文更新前写到一半的备注'});
      }
      const content=operation==='title'?original.content:operation==='trim'?original.content.split('\n\n').slice(10).join('\n\n')
        :operation==='inline'?original.content.replace(before.text,'补充的前文。'.repeat(90)+before.text)
          :Array.from({length:20},(_,i)=>'新增第'+(i+1)+'段。新补充的事情发生在前面。').join('\n\n')+'\n\n'+original.content;
      await update({content,title:operation==='title'?'改后的标题':original.title,content_version:'updated-1'});
      ensure(await evaluate('document.querySelector(".reader-body-text").textContent==='+JSON.stringify(oldText)),label+' detection keeps the old visible text until explicit reload');
      if(operation==='notes'){
        const load='document.querySelector("[data-reader-mark-load-edition]")';
        ensure(await evaluate(save+'.getAttribute("aria-disabled")==="true" && document.querySelector(".reader-marks-position-recovery").textContent.includes("本话已更新")'),label+' explains the chapter update and disables stale saves');
        await evaluate('resumeFixture.failChapter=1');await activate(load);await wait('!!document.querySelector(".reader-marks-position-recovery [role=alert]")');
        ensure(await evaluate(note+'.value==="正文更新前写到一半的备注" && document.querySelector(".reader-body-text").textContent==='+JSON.stringify(oldText)),label+' failed reload retains the open draft and old text');
        await evaluate('resumeFixture.failChapter=0');await activate(load);await wait('!document.querySelector(".reader-marks-panel")');await ready();await sleep(650);
        const after=await anchor();ensure(before.snippet===after.snippet&&Math.abs(before.y-after.y)<=3,label+' returning from the note panel restores the same sentence',{before,after});
        await openMarks();ensure(await evaluate(note+'.value==="正文更新前写到一半的备注"'),label+' successful reload retains the unsaved draft');
        await activate(save);await wait('document.querySelector(".reader-mark-compose")?.textContent.includes("草稿来自更新前的正文") || document.querySelector(".reader-marks-panel")?.textContent.includes("草稿来自更新前的正文")');
        ensure(await evaluate('resumeFixture.marks().length===0'),label+' old draft coordinates cannot silently bind to the revised text');
        const adopt='Array.from(document.querySelectorAll(".reader-mark-compose button")).find(e=>e.textContent.includes("改存到当前位置"))';
        await activate(adopt);await activate(save);await wait('resumeFixture.marks().length===1');
        ensure(await evaluate('resumeFixture.marks()[0].note==="正文更新前写到一半的备注" && '+note+'.value===""'),label+' explicit adoption saves the retained draft once');
        await screenshot('chapter-update-notes-'+width);continue;
      }
      await reveal();
      if(operation==='failure'){
        await evaluate('resumeFixture.failChapter=1');await activate(action);await wait(action+'.textContent.includes("新版加载失败")');
        ensure(await evaluate('document.querySelector(".reader-body-text").textContent==='+JSON.stringify(oldText)),label+' failed reload preserves readable content');
        await evaluate('resumeFixture.failChapter=0');
      }
      await evaluate('resumeFixture.holdChapter=1;resumeFixture.chapterSnapshotBeforeHold='+String(operation==='stale'));await activate(action);await wait(action+'.disabled && resumeFixture.pendingChapters.length>0');
      const reads=await evaluate('resumeFixture.chapterReads');await evaluate(action+'.click()');await sleep(100);
      ensure(await evaluate('resumeFixture.chapterReads==='+reads+' && document.querySelector(".reader-body-text").textContent==='+JSON.stringify(oldText)),label+' repeated clicks share one load and keep the old text');
      if(operation==='navigation'){
        await activate('document.querySelector("[aria-label=打开目录]")');await wait('!!document.querySelector(".reader-toc-panel")');
        await activate('Array.from(document.querySelectorAll(".reader-toc-item")).find(e=>e.querySelector("span")?.textContent.trim()==="2")');
        if(await evaluate('!!document.querySelector("[aria-label=关闭目录]")'))await activate('document.querySelector("[aria-label=关闭目录]")');
        await wait('document.querySelector(".reader-chapter-heading h1")?.textContent==="第2话"');
        await evaluate('resumeFixture.holdChapter=0;resumeFixture.pendingChapters.splice(0).forEach(resolve=>resolve())');await sleep(400);
        ensure(await evaluate('document.querySelector(".reader-chapter-heading h1")?.textContent==="第2话"'),label+' late update response cannot replace a later chapter selection');continue;
      }
      if(operation==='stale'){
        await evaluate('(()=>{resumeFixture.chapterEdits.set(1,{content:'+JSON.stringify(content+'\n\n再次修订时追加的尾声。')+',content_version:"updated-2"});resumeFixture.resource.toc[0].content_version="updated-2";resumeFixture.resource.version="2026-11-08T00:00:00Z";window.dispatchEvent(new Event("focus"));})()');await sleep(150);
        await evaluate('resumeFixture.holdChapter=0;resumeFixture.pendingChapters.splice(0).forEach(resolve=>resolve())');await wait(action+'.textContent.includes("新版加载失败")');
        ensure(await evaluate('document.querySelector(".reader-body-text").textContent==='+JSON.stringify(oldText)),label+' mismatched directory and chapter revisions keep the old text with retry');
        await evaluate('resumeFixture.chapterSnapshotBeforeHold=false');await activate(action);
      }
      await evaluate('resumeFixture.holdChapter=0;resumeFixture.pendingChapters.splice(0).forEach(resolve=>resolve())');
      await wait('!'+action);await ready();await sleep(650);
      const after=operation==='inline'?await pinned(before):await anchor();
      if(operation==='start')ensure(await evaluate(scroller+'.scrollTop<=1'),label+' preserves chapter-start boundary');
      else if(operation==='end')ensure(await evaluate('resumeFixture.progress().epub_cfi==="aisu-scroll:1"'),label+' preserves chapter-end boundary');
      else ensure(before.snippet===after.snippet&&Math.abs(before.y-after.y)<=3,label+' keeps the surviving sentence on the same screen line',{before,after});
      ensure(await evaluate('resumeFixture.progress().chapter_index===1'),label+' saves the restored chapter only after loading');
      if(operation==='prepend')await screenshot('chapter-update-position-'+width);
      await evaluate('fixtureNavigate("/library")');await wait('!document.querySelector(".reader-body-text")');await evaluate('fixtureNavigate("/reader/novel/resume-test")');await ready();await sleep(250);
      const reopened=operation==='inline'?await pinned(before):await anchor();
      if(!['start','end'].includes(operation))ensure(before.snippet===reopened.snippet&&Math.abs(before.y-reopened.y)<=3,label+' reopening retains the corrected reading position',{before,reopened});
    }
  }
}
