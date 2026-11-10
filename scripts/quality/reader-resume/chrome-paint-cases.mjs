/** Check painted controls as well as DOM geometry: an occluded rail can look like a jump. */
export async function verifyChromePaint({ command, ensure, evaluate, fresh, readAt, screenshot, sleep }) {
  const snapshot = `(()=>{
    const shell=document.querySelector('.reader-viewport'),bar=document.querySelector('.reader-bottom-bar');
    const rail=document.querySelector('.reader-scroll-position'),thumb=rail?.firstElementChild,status=document.querySelector('.reader-reading-status');
    const rect=e=>{if(!e?.getClientRects().length)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,left:r.left,width:r.width}};
    const r=rect(thumb),style=getComputedStyle(bar),scroll=document.querySelector('.reader-document-scroll')?document.scrollingElement:shell;
    const hits=r?[.1,.5,.9].map(p=>document.elementFromPoint(r.left+r.width/2,r.top+r.height*p)).map(e=>!!e&&rail.contains(e)):[];
    return {visible:!bar.inert,opacity:Number(style.opacity),visibility:style.visibility,transform:style.transform,
      clip:shell.style.clipPath,statusPaint:getComputedStyle(status).visibility,scroll:scroll.scrollTop,scrollHeight:scroll.scrollHeight,
      viewport:rect(shell),rail:rect(rail),thumb:r,hits};
  })()`;
  const tap = async (touch) => {
    const point=await evaluate('({x:(visualViewport?.offsetLeft||0)+(visualViewport?.width||innerWidth)/2,y:(visualViewport?.offsetTop||0)+(visualViewport?.height||innerHeight)/2})');
    if(touch) {
      await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
      await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    } else {
      await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
  };
  const sampleToggle = async (touch) => {
    await evaluate(`window.paintSamples=[];window.paintDone=new Promise(resolve=>{const start=performance.now();const tick=()=>{paintSamples.push(${snapshot});if(performance.now()-start<300)requestAnimationFrame(tick);else resolve(paintSamples)};tick()});true`);
    await tap(touch);
    return evaluate('paintDone');
  };
  const stable = (samples,before) => samples.every(s=>Math.abs(s.scroll-before.scroll)<1&&s.scrollHeight===before.scrollHeight
    &&Math.abs(s.viewport.top-before.viewport.top)<1&&Math.abs(s.viewport.bottom-before.viewport.bottom)<1
    &&(!before.rail||Math.abs(s.rail.top-before.rail.top)<1&&Math.abs(s.rail.bottom-before.rail.bottom)<1&&Math.abs(s.thumb.top-before.thumb.top)<1));
  const monotonic = (samples,direction) => samples.every((s,i)=>!i||(s.opacity-samples[i-1].opacity)*direction>=-0.001);
  const cases=[
    [1536,864,false,false,'dark',1,'middle'],[1536,864,false,false,'paper',1,'end'],
    [1024,600,false,false,'white',1,'end'],[1536,864,false,false,'green',1.5,'end'],
    [390,844,true,false,'dark',1,'middle'],[768,1024,true,false,'paper',1,'end'],
    [390,844,true,true,'white',1,'middle'],[768,1024,true,true,'green',1,'middle'],
  ];
  for(const [width,height,touch,paged,theme,zoom,position] of cases) {
    await command('Emulation.setPageScaleFactor',{pageScaleFactor:1});
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await fresh(width,height,touch,'theme='+theme+(paged?'&paged':''));
    if(zoom!==1) {await command('Emulation.setPageScaleFactor',{pageScaleFactor:zoom});await sleep(200);}
    await readAt(position==='end'?1e8:4000);
    const before=await evaluate(snapshot),label=`${width} ${paged?'paged':'scroll'} ${theme} zoom ${zoom} ${position}`;
    const shown=await sampleToggle(touch);
    ensure(shown.at(-1).visible&&shown.at(-1).opacity===1,label+' a reveal stays visible after one gesture');
    ensure(stable(shown,before),label+' reveal preserves prose, scroll range and rail coordinates');
    ensure(shown.every(s=>s.clip===''&&s.transform==='none'&&s.statusPaint==='visible'),label+' reveal preserves the reading surface and reserved status background');
    ensure(monotonic(shown,1)&&shown.some(s=>s.opacity>0&&s.opacity<1),label+' reveal fades once without a flash');
    if(before.rail) ensure(shown.every(s=>s.hits.every(Boolean)),label+' the entire right progress thumb remains visible above controls',shown.filter(s=>s.hits.some(h=>!h)));
    await screenshot('reader-paint-'+width+'-'+theme+'-'+zoom+'-shown');
    const hidden=await sampleToggle(touch);
    ensure(!hidden.at(-1).visible&&hidden.at(-1).opacity===0&&hidden.at(-1).visibility==='hidden',label+' dismiss completes cleanly');
    ensure(stable(hidden,before)&&monotonic(hidden,-1),label+' dismissal does not flash or move reading progress');
    await tap(touch);await sleep(45);await tap(touch);await sleep(25);await tap(touch);await sleep(220);
    const rapid=await evaluate(snapshot);
    ensure(rapid.visible&&rapid.opacity===1&&stable([rapid],before),label+' rapid reversals settle without moving prose');
    await sleep(3400);const automatic=await evaluate(snapshot);
    ensure(!automatic.visible&&automatic.opacity===0&&stable([automatic],before),label+' automatic hiding leaves progress stationary');
  }
  await command('Emulation.setPageScaleFactor',{pageScaleFactor:1});
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await fresh(1536,864,false,'theme=dark');await readAt(4000);await tap(false);await sleep(40);
  ensure(await evaluate(`document.querySelector('.reader-bottom-bar').inert===false&&getComputedStyle(document.querySelector('.reader-bottom-bar')).transitionDuration.split(',').every(v=>parseFloat(v)===0)`),'reduced motion reveals controls without animation');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
}
