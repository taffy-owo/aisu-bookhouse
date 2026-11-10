export async function verifyChapterEditPositions({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot }) {
  const scroller='(document.querySelector(".reader-document-scroll")?document.scrollingElement:document.querySelector(".reader-viewport"))';
  const anchor=()=>evaluate('(()=>{const e='+scroller+',top=e===document.scrollingElement?80:e.getBoundingClientRect().top+80,p=[...document.querySelectorAll(".reader-body-text p")].find(p=>p.getBoundingClientRect().bottom>top);if(!p)return{};const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),range=document.createRange();let node;while((node=walker.nextNode())){if(node.parentElement.closest("rt,rp"))continue;for(let i=0;i<node.length;i++){range.setStart(node,i);range.setEnd(node,i+1);const rect=range.getBoundingClientRect();if(rect.bottom>top)return{text:p.textContent,snippet:node.data.slice(i,i+24),y:rect.top,scroll:e.scrollTop};}}return{text:p.textContent,y:p.getBoundingClientRect().top,scroll:e.scrollTop}})()');
  const editor='document.querySelector("[aria-label=编辑本章]")';
  const pinned=before=>evaluate('(()=>{const before='+JSON.stringify(before)+',p=[...document.querySelectorAll(".reader-body-text p")].find(p=>p.textContent.endsWith(before.text));if(!p)return{};const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),range=document.createRange();let node;while((node=walker.nextNode())){const i=node.data.indexOf(before.snippet);if(i<0)continue;range.setStart(node,i);range.setEnd(node,i+1);return{snippet:before.snippet,y:range.getBoundingClientRect().top};}return{}})()');
  const dialog='document.querySelector("[role=dialog]")';
  const atBoundary=end=>evaluate('(()=>{const e='+scroller+',doc=e===document.scrollingElement,body=document.querySelector(".reader-body-text"),status=document.querySelector(".reader-reading-status"),bottom=doc?innerHeight-(status?.getBoundingClientRect().height??26):e.getBoundingClientRect().bottom,max=Math.max(0,Math.min(e.scrollHeight-e.clientHeight,e.scrollTop+body.getBoundingClientRect().bottom-bottom));return '+(end?'Math.abs(e.scrollTop-max)<=1':'e.scrollTop<=1')+'})()');
  const openEditor=async()=>{
    if(await evaluate('!!'+editor+'?.closest("[inert]")')){
      const point=await evaluate('({x:innerWidth/2,y:innerHeight/2})');
      await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
    await wait('!!'+editor+' && !'+editor+'.closest("[inert]")');await click(editor);
    await wait('!!'+dialog+'?.querySelector("textarea")');
  };
  for(const [width,height,touch] of [[1536,864,false],[768,1024,true],[390,844,true]]){
    for(const operation of ['prepend','trim','inline-prepend','title','prepend-start','prepend-end']){
      const label=width+' chapter edit '+operation;
      await fresh(width,height,touch,'persistEditor&theme=dark');
      await wait('document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');
      await evaluate(scroller+'.scrollTop='+ (operation==='prepend-start'?0:operation==='prepend-end'?1e9:4000));await sleep(700);
      const before=await anchor();
      await openEditor();
      const original=await evaluate(dialog+'.querySelector("textarea").value');
      const revised=operation.startsWith('prepend')?Array.from({length:20},(_,i)=>`新补充第${i+1}段。此前发生的事情，现在补充在章节前面。`).join('\n\n')+'\n\n'+original
        :operation==='trim'?original.split('\n\n').slice(10).join('\n\n')
          :operation==='inline-prepend'?original.replace(before.text,'同一段落中补充的新句子，原先读到的句子应留在原处。'.repeat(15)+before.text):original;
      if(operation==='title'){
        await evaluate(dialog+'.querySelector("input").focus();'+dialog+'.querySelector("input").select()');
        await command('Input.insertText',{text:'只修改标题'});
      }else{
        await evaluate(dialog+'.querySelector("textarea").focus();'+dialog+'.querySelector("textarea").select()');
        await command('Input.insertText',{text:revised});
      }
      await click('document.querySelector(".chapter-editor-save")');
      await wait('!'+dialog+' && document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');
      await wait('document.body.style.position!=="fixed"');await sleep(650);
      const after=operation==='inline-prepend'?await pinned(before):await anchor();
      if(operation==='prepend-start' || operation==='prepend-end')ensure(await atBoundary(operation==='prepend-end'),label+' preserves the requested start or end boundary',{before,after});
      else ensure(before.snippet===after.snippet && Math.abs(before.y-after.y)<=3,label+' keeps the same visible text and line after saving',{before,after});
      ensure(await evaluate('resumeFixture.editorRequests.filter(r=>r.operation==="save").length===1'),label+' publishes one edit');
      if(operation==='prepend')await screenshot('chapter-edit-position-'+width);
      await evaluate('fixtureNavigate("/library")');await wait('!document.querySelector(".reader-body-text")');
      await evaluate('fixtureNavigate("/reader/novel/resume-test")');
      await wait('document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');await sleep(250);
      const reopened=operation==='inline-prepend'?await pinned(before):await anchor();
      if(operation==='prepend-start' || operation==='prepend-end')ensure(await atBoundary(operation==='prepend-end'),label+' reopens at the saved start or end boundary',reopened);
      else ensure(before.snippet===reopened.snippet && Math.abs(before.y-reopened.y)<=3,label+' reopens at the corrected reading position',{before,reopened});
    }
  }
}
