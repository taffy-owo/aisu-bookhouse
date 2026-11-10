import fs from 'node:fs';
import path from 'node:path';

export async function verifyImageControls({ command, ensure, evaluate, fresh, wait, click, reveal, sleep, screenshot, baseline, reportDir }) {
  const observations=[];
  const control=label=>`document.querySelector('[aria-label="${label}"]')`;
  const activate=async label=>{
    await reveal('[aria-label="'+label+'"]');
    await evaluate(`${control(label)}.scrollIntoView({block:'nearest',inline:'nearest'})`);await sleep(40);
    const reachable=await evaluate(`(()=>{const e=${control(label)},r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
    if(!reachable)throw Error('Image control is covered: '+label);
    await click(control(label));await sleep(90);
  };
  const key=async(key,code,keyCode)=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:keyCode,text:key==='Enter'?'\r':undefined});await command('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:keyCode});await sleep(100);};
  const snapshot=()=>evaluate(`(()=>{
    const s=document.querySelector('.reader-mobile-pan'),image=s.querySelector('img'),b=s.getBoundingClientRect(),r=image.getBoundingClientRect(),ratio=image.naturalWidth/image.naturalHeight;
    const width=Math.min(r.width,r.height*ratio),height=width/ratio,left=r.left+(r.width-width)/2,top=r.top+(r.height-height)/2;
    return{stage:{left:b.left,top:b.top,right:b.left+s.clientWidth,bottom:b.top+s.clientHeight,width:s.clientWidth,height:s.clientHeight},image:{left,top,right:left+width,bottom:top+height,width,height},scroll:{left:s.scrollLeft,top:s.scrollTop,width:s.scrollWidth,height:s.scrollHeight},point:{x:(b.left+s.clientWidth/2-left)/width,y:(b.top+s.clientHeight/2-top)/height},scale:document.querySelector('[aria-label="重置漫画缩放"]').textContent,focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName,page:image.alt};
  })()`);
  const layouts=baseline?[[1536,864,false,16],[390,844,true,16],[844,390,true,16]]:[[1536,864,false,16],[768,1024,true,16],[390,844,true,16],[844,390,true,16],[320,640,true,32],[320,280,true,32]];
  for(const [width,height,touch,fontSize] of layouts.filter(item=>!process.env.READER_IMAGE_TEST_WIDTH||item[0]===Number(process.env.READER_IMAGE_TEST_WIDTH)))for(const strip of [false,true]){
    const label=`${width}x${height} ${fontSize}px ${strip?'strip':'image'}`;
    await fresh(width,height,touch,'readableManga'+(strip?'&longStrip':''),false);
    await wait('document.querySelector(".reader-mobile-pan img")?.naturalWidth>0');
    await evaluate(`document.documentElement.style.fontSize='${fontSize}px'`);await sleep(250);
    const initial=await snapshot();await activate('放大漫画');const enlarged=await snapshot();
    for(let i=0;i<7;i++)await activate('放大漫画');
    const maximum=await snapshot();await key('Enter','Enter',13);const maximumRepeat=await snapshot();
    await evaluate("document.querySelector('.reader-mobile-pan').scrollTo({left:0,top:0,behavior:'instant'})");await sleep(70);const start=await snapshot();
    await evaluate("document.querySelector('.reader-mobile-pan').scrollTo({left:1e7,top:1e7,behavior:'instant'})");await sleep(70);const end=await snapshot();
    await evaluate("(()=>{const s=document.querySelector('.reader-mobile-pan');s.scrollTo({left:(s.scrollWidth-s.clientWidth)*.4,top:(s.scrollHeight-s.clientHeight)*.4,behavior:'instant'})})()");await sleep(70);
    const beforeZoom=await snapshot();await activate('缩小漫画');const afterZoom=await snapshot();
    if(!baseline&&height>=390&&fontSize===16){
      await click("document.querySelector('.reader-mobile-pan')");await sleep(850);const toggled=await snapshot();
      ensure(Math.abs(toggled.scroll.top-afterZoom.scroll.top)<1&&Math.abs(toggled.scroll.left-afterZoom.scroll.left)<1&&toggled.scale===afterZoom.scale,label+' toggling controls keeps a zoomed image stationary');
    }
    if(!baseline&&touch&&height>=390&&fontSize===16){
      await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width/2,y:height/2}]});
      for(let step=1;step<=10;step++){await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width/2,y:height/2-step*10}]});await sleep(20);}
      await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(700);
      const panned=await snapshot();
      ensure(panned.page===afterZoom.page&&panned.scroll.top>afterZoom.scroll.top+20,label+' a real touch drag pans the zoomed image without changing pages',{afterZoom,panned});
    }
    await screenshot(`image-controls-${width}-${height}-${fontSize}-${strip?'strip':'page'}${baseline?'-baseline':''}`);
    await activate('重置漫画缩放');
    await evaluate("document.querySelector('.reader-mobile-pan').scrollTop=800");await sleep(70);const beforePage=await snapshot();
    await activate('下一页');await wait('document.querySelector(".reader-mobile-pan img")?.alt.endsWith("第 2 页")');await sleep(180);const afterPage=await snapshot();
    await activate('下一页');await wait('document.querySelector(".reader-mobile-pan img")?.alt.endsWith("第 3 页")');await sleep(100);const lastPage=await snapshot();
    const item={label,initial,enlarged,maximum,maximumRepeat,start,end,beforeZoom,afterZoom,beforePage,afterPage,lastPage};observations.push(item);console.log('IMAGE_CONTROLS_OBSERVED',JSON.stringify(item));
    if(!baseline){
      ensure(Math.abs(enlarged.image.width/initial.image.width-1.25)<.015&&Math.abs(enlarged.image.height/initial.image.height-1.25)<.015,label+' 125 percent scales the fitted image proportionally');
      ensure(maximum.scale==='300%'&&maximum.focus==='放大漫画'&&maximumRepeat.scale==='300%'&&maximumRepeat.focus==='放大漫画',label+' maximum and repeated activation keep focus and scale');
      ensure(start.image.left>=start.stage.left-1&&start.image.top>=start.stage.top-1&&end.image.right<=end.stage.right+1&&end.image.bottom<=end.stage.bottom+1,label+' all image edges remain reachable by panning');
      ensure(Math.abs(beforeZoom.point.x-afterZoom.point.x)*afterZoom.image.width<3&&Math.abs(beforeZoom.point.y-afterZoom.point.y)*afterZoom.image.height<3,label+' changing zoom preserves the viewed image point');
      ensure(afterPage.scroll.left<=1&&afterPage.scroll.top<=1&&afterPage.scale==='100%',label+' the next page begins at the start with fit zoom');
      ensure(lastPage.focus==='下一页',label+' reaching the final page keeps the navigation focus');
      await key('Enter','Enter',13);
      ensure((await snapshot()).page===lastPage.page,label+' repeated final-page activation stays on the same page');
      await activate('重置漫画缩放');await activate('缩小漫画');
      const minimum=await snapshot();await key('Enter','Enter',13);const minimumRepeat=await snapshot();
      ensure(minimum.scale==='75%'&&minimum.focus==='缩小漫画'&&minimumRepeat.scale==='75%'&&minimumRepeat.focus==='缩小漫画',label+' minimum zoom retains focus and rejects repeated activation');
      await activate('上一页');await activate('上一页');await key('Enter','Enter',13);const firstPage=await snapshot();
      ensure(firstPage.page.endsWith('第 1 页')&&firstPage.focus==='上一页',label+' first-page boundary retains focus without navigating');
      const layout=await evaluate(`(()=>{const panel=document.querySelector('.manga-page-navigator');return{width:panel.clientWidth,scrollWidth:panel.scrollWidth,targets:[...panel.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return{label:e.getAttribute('aria-label'),width:r.width,height:r.height}})}})()`);
      ensure(layout.scrollWidth<=layout.width+1&&layout.targets.every(t=>t.width>=44&&t.height>=44),label+' the toolbar fits without horizontal overflow and has usable touch targets',layout);
      if(height>=390&&fontSize===16){
        const pointer=async(point,count=1)=>{await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:count,...point});await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:count,...point});};
        if(await evaluate("!document.querySelector('.manga-page-navigator').inert")){await pointer({x:width/2,y:(height-44)/2});await sleep(850);}
        const fitted=await snapshot(),point={x:fitted.stage.left+fitted.stage.width/2,y:fitted.stage.top+fitted.stage.height/2};
        await pointer(point);await sleep(40);await pointer(point,2);await sleep(700);const doubled=await snapshot();
        ensure(doubled.scale==='175%'&&doubled.page===fitted.page,label+' a real double click zooms without turning a page');
        ensure(Math.abs(doubled.point.x-fitted.point.x)*doubled.image.width<3&&Math.abs(doubled.point.y-fitted.point.y)*doubled.image.height<3,label+' double-click zoom keeps the viewed image point',{fitted,doubled});
        await command('Emulation.setDeviceMetricsOverride',{width:width-30,height:height+70,deviceScaleFactor:1,mobile:touch});await sleep(250);const resized=await snapshot();
        ensure(resized.scale==='175%'&&resized.page===doubled.page&&Math.abs(resized.point.x-doubled.point.x)*resized.image.width<3&&Math.abs(resized.point.y-doubled.point.y)*resized.image.height<3,label+' viewport resizing keeps zoom and the viewed image point',{doubled,resized});
        if(touch){
          await activate('重置漫画缩放');
          if(await evaluate("!document.querySelector('.manga-page-navigator').inert")){await pointer({x:(width-30)/2,y:(height+26)/2});await sleep(850);}
          const tap=async x=>{await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:(height+26)/2}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(850);};
          await tap((width-30)*.8);const right=await snapshot();await tap((width-30)*.2);const left=await snapshot();
          ensure(right.page.endsWith('第 2 页')&&left.page.endsWith('第 1 页'),label+' real touch taps on the right and left still turn pages');
        }
      }
    }
    await evaluate("document.documentElement.style.fontSize=''");
  }
  fs.writeFileSync(path.join(reportDir,baseline?'image-controls-baseline.json':'image-controls-observations.json'),JSON.stringify({observations},null,2));
}
