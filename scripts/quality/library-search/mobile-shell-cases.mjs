import fs from 'node:fs';
import path from 'node:path';

export async function verifyMobileShell({ command, evaluate, wait, ensure, click, sleep, origin, reportDir, baseline, entryUrl, endTarget, navigate: suppliedNavigate, exerciseRoutes = true }) {
  const observations = [];
  const nav = `document.querySelector('.mobile-bottom-nav')`;
  const brand = `document.querySelector('.mobile-brand-bar')`;
  const end = endTarget ?? `document.querySelector('[data-mobile-shell-final-action]')`;
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>console.error('Mobile shell browser error: '+e.message));addEventListener('unhandledrejection',e=>console.error('Mobile shell promise rejection: '+String(e.reason)));` });
  const key = async (name, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type:'keyDown', key:name, code:name, modifiers, windowsVirtualKeyCode:{Tab:9,Enter:13}[name] });
    await command('Input.dispatchKeyEvent', { type:'keyUp', key:name, code:name, modifiers, windowsVirtualKeyCode:{Tab:9,Enter:13}[name] });
    await sleep(120);
  };
  const navigate = suppliedNavigate ?? (async pathname => {
    await evaluate(`searchFixture.navigate(${JSON.stringify(pathname)})`);
    await wait(`searchFixture.location.pathname===${JSON.stringify(pathname)}`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))');
  });
  const pointer = async expression => {
    const hit = await evaluate(`(()=>{const e=${expression};e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
    if(!hit)throw Error('Covered mobile shell action '+expression);
    await click(expression);
  };
  const screenshot = async name => {
    const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(reportDir,name+(baseline?'-baseline':'')+'.png'),Buffer.from(shot.data,'base64'));
  };
  const snapshot = () => evaluate(`(()=>{
    const nav=${nav},brand=${brand},header=document.querySelector('.topbar-shell');
    const rect=e=>{if(!e?.getClientRects().length)return null;const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const n=rect(nav),hit=e=>{const r=rect(e);return !r||e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
    const label=e=>{const span=e.querySelector('span');return{...rect(e),hit:hit(e),label:span.textContent,labelWidth:span.clientWidth,labelScroll:span.scrollWidth,fontSize:parseFloat(getComputedStyle(span).fontSize),icon:rect(e.querySelector('svg'))}};
    return{nav:n,brand:rect(brand),header:rect(header),buttons:[...brand.querySelectorAll('a,button')].map(e=>({...rect(e),hit:hit(e)})),items:n?[...nav.querySelectorAll('a')].map(label):[],overflow:document.documentElement.scrollWidth>innerWidth+1,reserved:getComputedStyle(document.documentElement).getPropertyValue('--app-mobile-nav-space'),bodyPadding:parseFloat(getComputedStyle(document.querySelector('aside.app-sidebar').parentElement).paddingBottom),navBottom:n?parseFloat(getComputedStyle(nav).bottom):0};
  })()`);
  const endSnapshot = () => evaluate(`(()=>{
    const e=${end};e.scrollIntoView({block:'end',behavior:'instant'});window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});
    const r=e.getBoundingClientRect(),n=${nav}.getBoundingClientRect();return{top:r.top,bottom:r.bottom,navTop:n.top,gap:n.top-r.bottom,hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),max:document.documentElement.scrollHeight-innerHeight,y:scrollY};
  })()`);
  const cases=[
    [390,844,true,16,'dark'],[320,640,true,16,'light'],[768,1024,true,16,'dark'],[844,390,true,16,'light'],
    [390,844,true,32,'dark'],[320,640,true,32,'light'],[768,1024,true,32,'dark'],[844,390,true,32,'light'],
    [320,280,true,32,'dark'],[1024,768,true,32,'light'],[1536,864,false,16,'dark'],
  ];
  let safeAreaSupported = null;
  for(const [width,height,touch,fontSize,theme] of cases){
    const label=`${width}x${height} ${fontSize}px ${theme}`;
    await command('Page.navigate',{url:'about:blank'});
    await command('Storage.clearDataForOrigin',{origin,storageTypes:'all'});
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:touch});
    await command('Emulation.setTouchEmulationEnabled',{enabled:touch,maxTouchPoints:touch?5:1});
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await command('Page.navigate',{url:entryUrl?entryUrl({theme,fontSize}):origin+'/scripts/quality/library-search/fixture.html?page=/settings&mobileShell=1&headerControls=1&theme='+theme});
    await wait(`!!${nav}&&!!${brand}&&!!${end}`);
    await evaluate(`document.documentElement.style.fontSize='${fontSize}px';window.scrollTo(0,0)`);await sleep(220);
    const initial=await snapshot();
    await screenshot(`mobile-shell-${width}-${height}-${fontSize}`);
    let ending=null;
    if(width<1024){
      ending=await endSnapshot();await sleep(100);
      if(!baseline){
        ensure(!initial.overflow,label+' mobile shell fits the page width',initial);
        ensure(initial.brand.height<=(width<400&&fontSize===32?120:72),label+' brand controls keep a compact single or wrapped row',initial.brand);
        ensure(initial.buttons.every(b=>b.width>=44&&b.height>=44&&b.width<=44&&b.height<=44),label+' brand actions retain 44px targets without growing with icons',initial.buttons);
        ensure(initial.nav.left>=0&&initial.nav.right<=width&&initial.nav.bottom<=height&&initial.nav.height<=(fontSize===32?88:68),label+' bottom navigation remains compact and within the viewport',initial.nav);
        ensure(initial.items.length===5&&initial.items.every(i=>i.width>=44&&i.height>=44&&i.hit&&i.labelScroll<=i.labelWidth+1&&i.icon.width<=20),label+' five navigation labels and touch targets remain visible',initial.items);
        ensure(initial.items.every(i=>i.fontSize>=fontSize*.6875),label+' navigation labels respect enlarged root text',initial.items);
        ensure(ending.top>=initial.header.height&&ending.gap>=8&&ending.hit,label+' the final page action stays above fixed navigation',ending);
        ensure(initial.bodyPadding>=initial.nav.height+initial.navBottom+8&&initial.bodyPadding<=initial.nav.height+initial.navBottom+24,label+' bottom page space follows the actual navigation size',initial);
        if(!endTarget){
          await pointer(end);
          ensure(await evaluate('searchFixture.endActions===1'),label+' final page action can be activated');
          await evaluate(`${end}.blur();${end}.focus()`);await sleep(100);
          ensure(await evaluate(`(()=>{const e=${end},r=e.getBoundingClientRect(),n=${nav}.getBoundingClientRect();return document.activeElement===e&&r.bottom<n.top&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`),label+' keyboard focus leaves the final action visible above navigation');
        }
        await evaluate('window.scrollTo(0,0)');await sleep(100);
        const themeBefore=await evaluate('document.documentElement.classList.contains("dark")');
        await pointer(`${brand}.querySelector('button')`);
        ensure(await evaluate('document.documentElement.classList.contains("dark")')!==themeBefore,label+' mobile appearance toggle works');
        await pointer(`${brand}.querySelector('button')`);
      }
      if(!baseline&&exerciseRoutes&&(width===390&&fontSize===16||width===320&&height===280)){
        for(const pathname of ['/','/library','/japanese','/upload','/public']){
          await pointer(`${nav}.querySelector('a[href="${pathname}"]')`);
          await wait(`searchFixture.location.pathname===${JSON.stringify(pathname)}`);await sleep(180);
          ensure(await evaluate(`${nav}.querySelectorAll('[aria-current="page"]').length===1&&${nav}.querySelector('[aria-current="page"]').getAttribute('href')===${JSON.stringify(pathname)}`),label+' selecting '+pathname+' updates the active navigation entry');
        }
        await navigate('/settings');await wait(`!!${end}`);await sleep(150);
        await evaluate(`${nav}.querySelector('a').focus({preventScroll:true})`);await key('Tab');
        ensure(await evaluate(`document.activeElement===${nav}.querySelector('a[href="/library"]')`),label+' Tab moves across mobile navigation');
        await key('Tab',8);await key('Enter');await wait(`searchFixture.location.pathname==='/'`);
        ensure(await evaluate(`${nav}.querySelector('[aria-current="page"]').getAttribute('href')==='/'`),label+' Enter opens the focused navigation entry');
        await navigate('/settings');await wait(`!!${end}`);
      }
      if(width===844&&fontSize===32){
        try{
          await command('Emulation.setSafeAreaInsets',{insets:{top:0,bottom:34,left:44,right:34}});safeAreaSupported=true;
          await sleep(180);const safe=await snapshot(),last=await endSnapshot();
          if(!baseline){
            ensure(safe.nav.left>=44&&safe.nav.right<=width-34&&safe.navBottom>=40,label+' navigation avoids landscape safe areas',safe);
            ensure(last.gap>=8&&last.hit,label+' safe-area changes keep the final page action reachable',last);
          }
          observations.push({label:label+' safe-area',initial:safe,ending:last});
          await command('Emulation.setSafeAreaInsets',{insets:{top:0,bottom:0,left:0,right:0}});await sleep(120);
        }catch(error){
          if(safeAreaSupported)throw error;
          safeAreaSupported=false;console.log('SAFE_AREA_UNAVAILABLE',String(error));
        }
      }
    }else if(!baseline){
      ensure(initial.brand===null&&initial.nav===null,label+' desktop uses its sidebar and hides the mobile shell');
      ensure(initial.reserved.trim()==='0px',label+' desktop releases the mobile bottom-space reservation',initial);
    }
    observations.push({label,initial,ending});
    console.log('MOBILE_SHELL_OBSERVED',JSON.stringify(observations.at(-1)));
  }
  if(!baseline){
    // Resize the same mounted shell: rotating a tablet and crossing the
    // desktop breakpoint must release and restore the bottom reservation.
    for(const [width,height] of [[768,1024],[844,390],[1024,768],[390,844]]){
      await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
      await sleep(180);const resized=await snapshot();
      if(width<1024){
        const ending=await endSnapshot();
        ensure(resized.nav&&resized.bodyPadding>=resized.nav.height+resized.navBottom+8&&ending.hit&&ending.gap>=8,`${width}x${height} resize keeps the last content above the navigation`,{resized,ending});
      }else ensure(!resized.nav&&resized.reserved.trim()==='0px','resizing to desktop releases mobile bottom space',resized);
      observations.push({label:`resize ${width}x${height}`,initial:resized});
    }
    if(exerciseRoutes){
      await navigate('/mobile-shell-exit');await wait('!!document.querySelector("[data-mobile-shell-exit]")');
      ensure(await evaluate(`!document.querySelector('.mobile-bottom-nav')&&!document.documentElement.style.getPropertyValue('--app-mobile-nav-space')&&getComputedStyle(document.documentElement).scrollPaddingBottom==='0px'`),'leaving the app shell removes its scroll and bottom-space reservation');
      await navigate('/settings');await wait(`!!${end}`);await sleep(180);
      const mounted=await snapshot();
      ensure(mounted.nav&&parseFloat(mounted.reserved)>mounted.nav.height,'returning to the app shell restores space for navigation',mounted);
    }
  }
  fs.writeFileSync(path.join(reportDir,baseline?'mobile-shell-baseline.json':'mobile-shell-observations.json'),JSON.stringify({safeAreaSupported,observations},null,2));
}
