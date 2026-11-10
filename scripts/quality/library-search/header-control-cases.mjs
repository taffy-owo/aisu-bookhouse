import fs from 'node:fs';
import path from 'node:path';

export async function verifyHeaderControls({ command, evaluate, wait, ensure, click, sleep, origin, reportDir, baseline, entryUrl }) {
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',event=>console.error('Header browser error: '+event.message));addEventListener('unhandledrejection',event=>console.error('Header promise rejection: '+String(event.reason)));` });
  const observations = [];
  const input = `document.querySelector('.topbar-search-input')`;
  const trigger = `document.querySelector('.topbar-notifications-toggle')`;
  const panel = `document.querySelector('#notification-panel')`;
  const account = `document.querySelector('.topbar-account-toggle')`;
  const pointer = async expression => {
    const hit = await evaluate(`(()=>{const e=${expression};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
    if(!hit)throw Error('Covered header action '+expression);
    await click(expression);
  };
  const key = async (name, modifiers = 0) => {
    const code = name === 'k' ? 'KeyK' : name;
    const windowsVirtualKeyCode = { Tab: 9, Escape: 27, k: 75 }[name];
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, modifiers, windowsVirtualKeyCode });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers, windowsVirtualKeyCode });
    await sleep(100);
  };
  const screenshot = async name => {
    const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(reportDir, name + (baseline ? '-baseline' : '') + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const headerSnapshot = () => evaluate(`(()=>{
    const input=${input},form=input.form,icon=form.querySelector('svg'),clear=form.querySelector('button'),shortcut=form.querySelector('kbd'),notice=${trigger};
    const rect=e=>{if(!e?.getClientRects().length)return null;const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const field=rect(input),c=rect(clear),s=rect(shortcut),i=rect(icon),style=getComputedStyle(input),hit=e=>{if(!e)return true;const r=rect(e);return !r||e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
    return{input:field,form:rect(form),clear:c,shortcut:s,icon:i,notification:rect(notice),account:rect(${account}),contentWidth:input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),textSize:parseFloat(style.fontSize),clearHit:hit(clear),noticeHit:hit(notice),overlap:!!c&&!!s&&Math.min(c.right,s.right)>Math.max(c.left,s.left)&&Math.min(c.bottom,s.bottom)>Math.max(c.top,s.top),overflow:document.documentElement.scrollWidth>innerWidth+1};
  })()`);
  const panelSnapshot = () => evaluate(`(()=>{
    const p=${panel},header=p.firstElementChild,body=p.children[1],footer=p.children[2];
    const rect=e=>{if(!e?.getClientRects().length)return null;const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const r=rect(p),b=rect(body),hit=e=>{const r=rect(e);return !!r&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
    return{panel:r,header:rect(header),body:b,footer:rect(footer),scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,bodyScroll:body.scrollHeight,bodyClient:body.clientHeight,overflow:p.scrollWidth>p.clientWidth+1,closeHit:hit(p.querySelector('[aria-label="关闭更新通知"]')),refreshHit:hit(p.querySelector('[aria-label="刷新更新通知"]')),focusInside:p.contains(document.activeElement),compact:p.dataset.viewportCompact==='true',titleWidth:header.querySelector('h2').clientWidth};
  })()`);
  const scrollToAction = async expression => {
    return evaluate(`(()=>{const e=${expression};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{visible:r.top>=0&&r.bottom<=innerHeight,hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}})()`);
  };
  for (const [width, height, touch, fontSize, theme] of [
    [1536,864,false,16,'dark'], [1536,864,false,32,'light'], [1024,600,false,16,'light'], [1024,320,false,32,'dark'],
    [1024,768,true,16,'light'], [768,1024,true,32,'light'], [390,844,true,16,'dark'],
    [390,844,true,32,'dark'], [320,640,true,32,'light'], [844,390,true,32,'dark'], [320,280,true,32,'light'],
  ]) {
    const label = `${width}x${height} ${fontSize}px ${touch?'touch':'desktop'} ${theme}`;
    await command('Page.navigate', { url: 'about:blank' });
    await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
    await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await command('Page.navigate', { url: entryUrl ? entryUrl({ theme, fontSize }) : origin + '/scripts/quality/library-search/fixture.html?page=/settings&headerControls=1&theme=' + theme });
    await wait(`!!${input} && !!window.searchFixture`);
    await evaluate(`document.documentElement.style.fontSize='${fontSize}px';document.querySelector('.topbar-shell').scrollIntoView({block:'start'})`); await sleep(200);
    await evaluate(`${input}.focus({preventScroll:true})`); await command('Input.insertText', { text: '长长的来信与图书馆' }); await sleep(100);
    const header = await headerSnapshot();
    await screenshot(`header-${width}-${height}-${fontSize}`);
    if (!baseline) {
      ensure(!header.overflow && header.input.right <= header.form.right && header.form.right <= header.notification.left, label + ' search and notification stay separate without page overflow', header);
      ensure(header.contentWidth >= Math.min(120, header.textSize * 6), label + ' search leaves room for at least six characters', header);
      ensure(!header.overlap && header.clearHit && header.noticeHit, label + ' clear, shortcut and notification remain distinct and clickable', header);
      ensure(!touch || header.clear.width>=44&&header.clear.height>=44&&header.notification.width>=44&&header.notification.height>=44, label + ' header touch targets are at least 44px', header);
      if(header.account)ensure(header.account.height<=44,label+' enlarged text keeps the account trigger compact',header.account);
      await pointer(`${input}.form.querySelector('button')`);
      ensure(await evaluate(`${input}.value===''&&document.activeElement===${input}`), label + ' clearing a draft keeps search focus');
      await key('k',2);
      ensure(await evaluate(`document.activeElement===${input}`), label + ' Ctrl K focuses the search input');
    }
    await pointer(trigger); await wait(`!!${panel} && !!${panel}.querySelector('a[href]')`); await sleep(200);
    const notice = await panelSnapshot();
    await screenshot(`notifications-${width}-${height}-${fontSize}`);
    if(!baseline) {
      ensure(notice.panel.left>=0&&notice.panel.right<=width&&notice.panel.top>=0&&notice.panel.bottom<=height&& !notice.overflow, label + ' notifications fit the visible viewport', notice);
      ensure(notice.focusInside && notice.closeHit && notice.refreshHit && notice.titleWidth>=fontSize, label + ' notification heading and close/refresh actions remain usable', notice);
      ensure(notice.body.height>=Math.min(120,notice.panel.height*.3)||notice.compact, label + ' notification content retains reading space or scrolls with the whole panel', notice);
      const last=await scrollToAction(`${panel}.querySelector('a[href="/books/home-5"]')`);
      ensure(last.visible&&last.hit,label+' the last notification is visible and clickable after scrolling',last);
      const footer=await scrollToAction(`Array.from(${panel}.querySelectorAll('button')).find(e=>e.textContent.includes('全部标为已读'))`);
      ensure(footer.visible&&footer.hit,label+' the bulk-read action is reachable without hiding it outside the panel',footer);
      await key('Escape');
      ensure(await evaluate(`!${panel}&&document.activeElement===${trigger}`),label+' Escape closes notifications and restores the opener');
      await pointer(trigger);await wait(`!!${panel}`);await sleep(100);await key('Tab',8);
      ensure(await evaluate(`!${panel}&&document.activeElement===${trigger}`),label+' Shift Tab from the first notification action returns to its opener');
      if(width===1536) {
        await pointer(trigger);await wait(`!!${panel}`);await sleep(100);
        await evaluate(`(()=>{const p=${panel},actions=p.querySelectorAll('button:not(:disabled),a[href]');actions[actions.length-1].focus()})()`);
        await key('Tab');
        ensure(await evaluate(`!${panel}&&document.activeElement===${account}`),label+' Tab after the last notification resumes beside the opener');
      }
    } else await key('Escape');
    let accountDetails = null;
    if (width>=1024) {
      await pointer(account); await wait(`!!document.querySelector('#account-popover')`); await sleep(120);
      accountDetails=await evaluate(`(()=>{const p=document.querySelector('#account-popover'),r=p.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,overflow:p.scrollWidth>p.clientWidth+1,scrollable:p.scrollHeight>p.clientHeight,focusInside:p.contains(document.activeElement),text:document.activeElement.textContent}})()`);
      await screenshot(`account-${width}-${height}-${fontSize}`);
      if(!baseline) {
        ensure(await evaluate(`document.activeElement===document.querySelector('#account-popover')`),label+' account opening starts at its visible summary');
        await key('Tab');
        ensure(await evaluate(`(()=>{const e=document.activeElement,p=document.querySelector('#account-popover'),r=e.getBoundingClientRect(),b=p.getBoundingClientRect();return e===p.querySelector('a[href]')&&r.top>=b.top&&r.bottom<=b.bottom&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`),label+' Tab brings the first account action visibly into view');
      }
      const exit=await scrollToAction(`document.querySelector('#account-popover button')`);
      if(!baseline) {
        ensure(accountDetails.left>=0&&accountDetails.right<=width&&accountDetails.bottom<=height&&!accountDetails.overflow,label+' long-name admin account menu fits the viewport',accountDetails);
        ensure(accountDetails.focusInside&&exit.visible&&exit.hit,label+' account actions including logout remain reachable', {accountDetails,exit});
      }
      await key('Escape');
      if(!baseline)ensure(await evaluate(`!document.querySelector('#account-popover')&&document.activeElement===${account}`),label+' account Escape restores trigger focus');
      if(!baseline&&width===1536) {
        await pointer(account);await key('Tab',8);
        ensure(await evaluate(`!document.querySelector('#account-popover')&&document.activeElement===${account}`),label+' Shift Tab from the account summary returns to the opener');
        await pointer(account);await key('Tab');await key('Tab',8);
        ensure(await evaluate(`!document.querySelector('#account-popover')&&document.activeElement===${account}`),label+' Shift Tab from the first account action returns to the opener');
        await pointer(account);await key('k',2);
        ensure(await evaluate(`!document.querySelector('#account-popover')&&document.activeElement===${input}`),label+' Ctrl K leaves the account menu and focuses search');
        await pointer(account);
        await pointer(`document.querySelector('#account-popover a[href="/settings"]')`);
        ensure(await evaluate(`!document.querySelector('#account-popover')&&location.pathname==='/settings'`),label+' following an account link dismisses the menu');
      }
    }
    observations.push({label,header,notice,account:accountDetails});
    console.log('HEADER_OBSERVED',JSON.stringify(observations.at(-1)));
  }
  if(!baseline) {
    await evaluate('searchFixture.notificationCount=0');
    await pointer(trigger);await wait(`${panel}?.textContent.includes('暂时没有小说更新')`);
    const empty=await scrollToAction(`${panel}.querySelector('.source-update-panel-body p')`);
    ensure(empty.visible&&empty.hit,'short enlarged-text notifications keep the empty-state message readable',empty);
    await evaluate('searchFixture.notificationError=true');
    await pointer(`${panel}.querySelector('[aria-label="刷新更新通知"]')`);
    await wait(`!!${panel}.querySelector('[role="alert"]')`);
    const retry=`Array.from(${panel}.querySelectorAll('button')).find(e=>e.textContent.includes('重试加载通知'))`;
    const failed=await scrollToAction(retry);
    ensure(failed.visible&&failed.hit,'short enlarged-text notifications keep failure recovery reachable',failed);
    await screenshot('notification-recovery-320-280-32');
    await evaluate('searchFixture.notificationError=false;searchFixture.notificationCount=6');
    await pointer(retry);await wait(`${panel}.querySelectorAll('a[href]').length===6&&!${panel}.querySelector('[role="alert"]')`);
    ensure(await evaluate(`${panel}.dataset.viewportCompact==='true'`),'notification recovery restores the list without losing its compact scrolling');
    await command('Emulation.setDeviceMetricsOverride',{width:768,height:1024,deviceScaleFactor:1,mobile:true});
    await wait(`${panel}.dataset.viewportCompact==='false'`);await sleep(150);
    const taller=await panelSnapshot();
    ensure(taller.panel.bottom<=1024&&taller.bodyClient>=120,'growing the viewport restores a separately scrollable notification list',taller);
    await command('Emulation.setDeviceMetricsOverride',{width:768,height:280,deviceScaleFactor:1,mobile:true});
    await wait(`${panel}.dataset.viewportCompact==='true'`);await sleep(150);
    const shorter=await panelSnapshot();
    ensure(shorter.panel.top>=0&&shorter.panel.bottom<=280,'shrinking the viewport keeps the complete notification panel inside the screen',shorter);
    await key('Escape');
    await command('Emulation.setDeviceMetricsOverride',{width:1024,height:600,deviceScaleFactor:1,mobile:false});
    await command('Emulation.setTouchEmulationEnabled',{enabled:false});await sleep(150);
    await pointer(account);
    await command('Emulation.setDeviceMetricsOverride',{width:768,height:600,deviceScaleFactor:1,mobile:false});
    await wait(`!document.querySelector('#account-popover')`);
    ensure(await evaluate(`!document.querySelector('#account-popover')`),'switching to the mobile header closes the hidden account menu');
  }
  fs.writeFileSync(path.join(reportDir,baseline?'header-controls-baseline.json':'header-controls-observations.json'),JSON.stringify({observations},null,2));
}
