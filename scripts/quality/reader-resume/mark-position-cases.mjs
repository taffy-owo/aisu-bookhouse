export async function verifyMarkPositions({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot }) {
  const open='document.querySelector("[aria-label=打开书签与备注]")';
  const row=id=>'document.querySelector('+JSON.stringify('[data-reader-mark-id="'+id+'"]')+')';
  const clickVisible=async expression=>{
    await evaluate('('+expression+').scrollIntoView({block:"center",behavior:"instant"})');
    await wait('(()=>{const e='+expression+',r=e.getBoundingClientRect();return r.width>0 && r.height>0 && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()');
    await click(expression);
  };
  const openMarks=async()=>{
    if(!await evaluate('!!'+open)){
      const tools='document.querySelector("[aria-label=更多阅读工具]")';
      await wait('!!'+tools);
      if(await evaluate('!!'+tools+'.closest("[inert]")')){
        const point=await evaluate('(()=>{const r=document.querySelector(".pdf-reader-scroll").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
        await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
        await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      }
      await wait('!'+tools+'.closest("[inert]")');
      await clickVisible(tools);
    }
    await wait('!!'+open);
    if(await evaluate('!!'+open+'.closest("[inert]")')){
      const point=await evaluate('({x:innerWidth/2,y:innerHeight/2})');
      await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
    await wait('!'+open+'.closest("[inert]")');await click(open);
    await wait('!!document.querySelector(".reader-mark-item")');
  };
  for(const [width,height,touch] of [[1536,864,false],[768,1024,true],[390,844,true]]){
    for(const format of ['epub','comic','image','pdf']){
      const query=format==='comic'?'readableManga':format==='image'?'readableImage':format==='pdf'?'pdf&pdfPages=3':'';
      const label=width+' '+format+' mark navigation';
      await fresh(width,height,touch,query+'&theme=dark',false);
      if(format==='pdf')await wait('!!document.querySelector(".pdf-canvas-page canvas, .pdf-reflow-text")');
      else await wait('!!'+open);
      const key=format==='epub'?'key-2':format==='pdf'?'fixture-pdf':'image-2';
      const coordinates=format==='epub'?{chapter_index:999,epub_cfi:'aisu-scroll:0.5'}:format==='pdf'?{page_number:2}:{image_index:999,page_number:999};
      const marks=await evaluate(`(async()=>{
        const seed=async extra=>await(await fetch('/api/v1/books/resume-test/marks',{method:'POST',body:JSON.stringify({reader_type:${JSON.stringify(format)},kind:'note',label:'保留的旁注',note:'原备注第一行。\\n第二行也要保留。',progress_percent:12,...extra})})).json();
        const lost=await seed({...${JSON.stringify(coordinates)},position_key:'missing-position'});
        const old=await seed({reader_type:${JSON.stringify(format==='pdf'?'epub':'pdf')},page_number:2});
        const unanchored=await seed({});
        const valid=await seed({...${JSON.stringify(coordinates)},position_key:${JSON.stringify(key)}});
        const beyond=${JSON.stringify(format)}==='pdf'?await seed({page_number:999,position_key:${JSON.stringify(key)}}):null;
        return {lost:lost.id,old:old.id,unanchored:unanchored.id,valid:valid.id,beyond:beyond?.id};
      })()`);
      await openMarks();
      for(const id of [marks.lost,marks.old,marks.unanchored,...marks.beyond?[marks.beyond]:[]]){
        await wait('!!'+row(id));
        ensure(await evaluate(row(id)+'.querySelector("[data-reader-mark-jump]").disabled'),label+' disables a cached mark without a current target: '+id);
        ensure(await evaluate(row(id)+'.textContent.includes("定位到当前") && '+row(id)+'.querySelector(".reader-mark-note").textContent==="原备注第一行。\\n第二行也要保留。"'),label+' retains the note and offers explicit relocation: '+id);
      }
      ensure(await evaluate(row(marks.old)+'.textContent.includes("旧阅读格式")'),label+' explains a format mismatch before clicking');
      ensure(await evaluate('!'+row(marks.valid)+'.querySelector("[data-reader-mark-jump]").disabled'),label+' keeps a surviving identity navigable');
      await screenshot('mark-position-'+format+'-'+width);
      await clickVisible('Array.from('+row(marks.lost)+'.querySelectorAll("button")).find(e=>e.textContent.includes("定位到当前"))');
      await wait('!'+row(marks.lost)+'.querySelector("[data-reader-mark-jump]").disabled');
      ensure(await evaluate(row(marks.lost)+'.querySelector(".reader-mark-note").textContent==="原备注第一行。\\n第二行也要保留。" && document.activeElement.hasAttribute("data-reader-mark-jump")'),label+' relocation preserves content and restores keyboard focus');
      await clickVisible(row(marks.valid)+'.querySelector("[data-reader-mark-jump]")');
      await wait('!document.querySelector(".reader-marks-panel")');
      if(format==='epub')await wait('document.querySelector(".reader-chapter-heading h1")?.textContent==="第2话"');
      else if(format==='pdf')await wait('resumeFixture.progress().page_number===2');
      else await wait('document.querySelector(".reader-mobile-pan img")?.alt.endsWith("第 2 页")');
      ensure(true,label+' jumps to the surviving current target');
      await sleep(100);
    }
  }
}
