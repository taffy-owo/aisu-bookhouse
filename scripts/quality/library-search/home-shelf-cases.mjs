import fs from 'node:fs';
import path from 'node:path';

export async function verifyHomeShelf({ command, evaluate, wait, ensure, click, sleep, origin, reportDir, baseline, entryUrl, navigate: suppliedNavigate, readyDetail }) {
  const observations = [];
  const rail = `document.querySelector('.recent-cover-rail')`;
  const previous = `document.querySelector('[aria-label="查看前面的书"]')`;
  const next = `document.querySelector('[aria-label="查看后面的书"]')`;
  const navigate = suppliedNavigate ?? (pathname => evaluate(`searchFixture.navigate(${JSON.stringify(pathname)})`));
  const press = async key => {
    const windowsVirtualKeyCode = { Enter: 13, Tab: 9 }[key];
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, text: key === 'Enter' ? '\r' : undefined });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode }); await sleep(500);
  };
  const snapshot = () => evaluate(`(()=>{const r=${rail},b=${previous},n=${next},rect=e=>{const s=e.getBoundingClientRect();return{top:s.top,bottom:s.bottom,left:s.left,right:s.right,width:s.width,height:s.height}},progress=r.querySelector('.recent-cover-progress'),range=document.createRange();range.selectNodeContents(progress.lastChild);return{left:r.scrollLeft,max:r.scrollWidth-r.clientWidth,y:scrollY,focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName,previousDisabled:b.disabled||b.getAttribute('aria-disabled')==='true',nextDisabled:n.disabled||n.getAttribute('aria-disabled')==='true',previous:rect(b),next:rect(n),rail:rect(r),percentRight:range.getBoundingClientRect().right-progress.getBoundingClientRect().right,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
  for (const [width,height,touch,fontSize,theme] of [[1536,864,false,16,'dark'],[768,1024,true,16,'light'],[390,844,true,16,'dark'],[320,640,true,32,'light']]) {
    const label=`${width}x${height} ${fontSize}px ${theme}`;
    await command('Page.navigate',{url:'about:blank'});
    await command('Storage.clearDataForOrigin',{origin,storageTypes:'all'});
    await command('Emulation.setDeviceMetricsOverride',{width,height,mobile:touch,deviceScaleFactor:1});
    await command('Emulation.setTouchEmulationEnabled',{enabled:touch,maxTouchPoints:touch?5:1});
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await command('Page.navigate',{url:entryUrl ? entryUrl({theme,fontSize}) : origin+`/scripts/quality/library-search/fixture.html?page=/&theme=${theme}`});
    await wait(`${rail}?.children.length===12`);
    await evaluate(`document.documentElement.style.fontSize='${fontSize}px';${rail}.scrollIntoView({block:'center'})`);await sleep(200);
    const initial=await snapshot();
    for(let step=0;step<20;step++){
      if(await evaluate(`${next}.disabled||${next}.getAttribute('aria-disabled')==='true'`))break;
      await click(next);await sleep(400);
    }
    const end=await snapshot();await press('Enter');const endRepeat=await snapshot();
    await evaluate(`${rail}.lastElementChild.scrollIntoView({block:'center'})`);await sleep(100);const leaving=await snapshot();
    await click(`${rail}.lastElementChild`);await wait(`location.pathname==='/books/home-11'`);
    if(readyDetail)await readyDetail();
    await evaluate('history.back()');await wait(`${rail}?.children.length===12`);await sleep(450);
    const returned=await snapshot();
    if(!baseline){
      ensure(!initial.overflow&&initial.next.width>=(touch?44:32)&&initial.next.height>=(touch?44:32),label+' recent shelf fits the page and exposes its controls',initial);
      ensure(initial.percentRight<=1,label+' long chapter names leave the reading percentage fully visible',initial);
      ensure(end.nextDisabled&&end.focus==='查看后面的书'&&endRepeat.focus===end.focus&&Math.abs(endRepeat.left-end.left)<1,label+' reaching the end retains focus and repeated Enter does not move the shelf',{end,endRepeat});
      ensure(Math.abs(returned.left-leaving.left)<2&&Math.abs(returned.y-leaving.y)<2,label+' Back restores both the recent shelf and document positions after delayed home loading',{leaving,returned});
    }
    for(let step=0;step<20;step++){
      if(await evaluate(`${previous}.disabled||${previous}.getAttribute('aria-disabled')==='true'`))break;
      await click(previous);await sleep(400);
    }
    const start=await snapshot();await press('Enter');const startRepeat=await snapshot();
    if(!baseline)ensure(start.previousDisabled&&start.focus==='查看前面的书'&&startRepeat.focus===start.focus&&startRepeat.left<1,label+' reaching the start retains focus and rejects repeated activation',{start,startRepeat});
    observations.push({label,initial,end,endRepeat,leaving,returned,start,startRepeat});
    const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(reportDir,`home-shelf-${width}-${fontSize}${baseline?'-baseline':''}.png`),Buffer.from(shot.data,'base64'));
    console.log('HOME_SHELF_OBSERVED',JSON.stringify(observations.at(-1)));
    if(!baseline){
      await evaluate(`${next}.focus({preventScroll:true})`);await press('Tab');
      ensure(await evaluate(`document.activeElement===${rail}`),label+' Tab continues from the controls into the scrollable shelf');
      await evaluate(`${rail}.scrollLeft=${rail}.scrollWidth/2`);await sleep(200);
      const refreshBefore=await snapshot();
      await evaluate('window.homeReadsBefore=searchFixture.overviewReads;window.dispatchEvent(new Event("focus"))');
      await wait('searchFixture.overviewReads>homeReadsBefore');await sleep(450);
      ensure(await evaluate(`Math.abs(${rail}.scrollLeft-${refreshBefore.left})<2`),label+' a background shelf refresh preserves the current horizontal position');
      await evaluate(`${next}.focus({preventScroll:true});searchFixture.homeCount=1;window.homeReadsBefore=searchFixture.overviewReads;window.dispatchEvent(new Event('focus'))`);
      await wait(`${rail}?.children.length===1&&!${next}`);
      ensure(await evaluate(`document.activeElement===${rail}`),label+' when refresh removes the arrows their focus returns to the shelf');
      await evaluate('searchFixture.homeCount=12');await navigate('/settings');await wait(`location.pathname==='/settings'`);
      await navigate('/');await wait(`${rail}?.children.length===12`);await sleep(150);
      ensure(await evaluate(`${rail}.scrollLeft<1&&scrollY<1`),label+' a new home visit starts at the beginning instead of reusing a prior history entry');
    }
  }
  fs.writeFileSync(path.join(reportDir,baseline?'home-shelf-baseline.json':'home-shelf-observations.json'),JSON.stringify({observations},null,2));
}
