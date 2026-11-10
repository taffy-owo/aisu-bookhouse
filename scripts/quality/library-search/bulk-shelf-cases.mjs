import fs from 'node:fs';
import path from 'node:path';

export async function verifyBulkShelf({ command, evaluate, wait, ensure, click, sleep, origin, reportDir, baseline }) {
  const dialog = `document.querySelector('[role="dialog"]')`;
  const button = text => `Array.from(document.querySelectorAll('.library-page button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const action = text => `Array.from(${dialog}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const visible = expression => evaluate(`(()=>{const e=${expression},r=e.getBoundingClientRect(),v=visualViewport;return r.left>=(v?.offsetLeft||0)&&r.right<=(v?.offsetLeft||0)+(v?.width||innerWidth)+1&&r.top>=(v?.offsetTop||0)&&r.bottom<=(v?.offsetTop||0)+(v?.height||innerHeight)+1&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
  const pointer = async expression => {
    await evaluate(`${expression}.scrollIntoView({block:'center',inline:'nearest'});true`); await sleep(100);
    if (!await visible(expression)) throw Error('Covered bulk target: ' + expression);
    await click(expression);
  };
  const key = async (name, shift = false) => {
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: { Tab: 9, Escape: 27 }[name], modifiers: shift ? 8 : 0 });
    await sleep(80);
  };
  const fill = async (expression, text) => {
    await evaluate(`${expression}.scrollIntoView({block:'center'});${expression}.focus();${expression}.select();true`);
    await command('Input.insertText', { text }); await sleep(80);
  };
  const fresh = async (width = 1536, height = 864, touch = false, font = 16, theme = 'light', grid = false) => {
    await command('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await command('Page.navigate', { url: 'about:blank' });
    await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
    await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await command('Page.navigate', { url: `${origin}/scripts/quality/library-search/fixture.html?manualPaging&bulkActions&theme=${theme}${grid ? '&grid' : ''}` });
    await wait(`document.querySelector('.library-page')?.dataset.navigationLoading==='false'&&!!document.querySelector('[data-shelf-footer]')`);
    await evaluate(`document.documentElement.style.fontSize='${font}px';document.fonts.ready.then(()=>true)`); await sleep(150);
    await pointer(button('批量管理')); await wait(`document.querySelectorAll('[data-book-id]').length===4`); await pointer(button('选择已加载'));
  };
  const open = async kind => {
    await pointer(button({ series: '设置系列', share: '申请共享', delete: '删除所选' }[kind]));
    await wait(`!!${dialog}`); await sleep(120);
  };
  const snapshot = () => evaluate(`(()=>{const d=${dialog},v=visualViewport,rect=e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};return{dialog:rect(d),viewport:{top:v?.offsetTop||0,left:v?.offsetLeft||0,width:v?.width||innerWidth,height:v?.height||innerHeight},overflow:d.scrollWidth>d.clientWidth+1,scrollWidth:d.scrollWidth,portalOverflow:d.parentElement.scrollWidth>d.parentElement.clientWidth+1,icons:[...d.querySelectorAll('svg')].map(rect),fields:[...d.querySelectorAll('input')].map(e=>({...rect(e),type:e.type,label:e.getAttribute('aria-label')})),clippedTitles:[...d.querySelectorAll('input[aria-label$="卷序"]')].some(e=>{const title=e.closest('label').querySelector('span > span');return title.scrollWidth>title.clientWidth+1}),focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.getAttribute('placeholder')||document.activeElement?.textContent,scrollTop:d.scrollTop}})()`);
  const screenshot = async name => { const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(reportDir, name + '.png'), Buffer.from(shot.data, 'base64')); };
  const observations = [];
  const cases = process.env.BULK_INTERACTIONS_ONLY ? [] : [
    [1536, 864, false, 16, 'light', 1], [390, 844, true, 16, 'dark', 1], [768, 1024, true, 16, 'light', 1],
    [320, 640, true, 32, 'dark', 1], [844, 390, true, 32, 'light', 1], [320, 280, true, 32, 'dark', 1],
    [1536, 864, false, 32, 'dark', 1], [1536, 900, false, 32, 'light', 1.5],
  ];
  for (const [width, height, touch, font, theme, scale] of cases) for (const kind of ['series', 'share', 'delete']) {
    await fresh(width, height < 300 ? 640 : height, touch, font, theme); await open(kind);
    if (height < 300) { await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch }); await sleep(150); }
    if (scale !== 1) { await command('Emulation.setPageScaleFactor', { pageScaleFactor: scale }); await sleep(200); }
    const label = `${kind} ${width}x${height} font${font} ${theme} scale${scale}`;
    const initial = await snapshot(); observations.push({ label, initial }); console.log('BULK_OBSERVED', JSON.stringify(observations.at(-1)));
    const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(reportDir, `bulk-${kind}-${width}-${height}-${font}-${scale}${baseline ? '-baseline' : ''}.png`), Buffer.from(shot.data, 'base64'));
    if (!baseline) {
      const r = initial.dialog, v = initial.viewport;
      ensure(!initial.overflow && !initial.portalOverflow && !initial.clippedTitles, label + ' long titles fit and retain their distinguishing endings', initial);
      ensure(r.top >= v.top && r.bottom <= v.top + v.height + 1 && r.left >= v.left && r.right <= v.left + v.width + 1, label + ' dialog stays in the visible viewport', initial);
      ensure(initial.icons.every(i => i.width <= 24 && i.height <= 24) && initial.fields.every(f => f.left >= r.left && f.right <= r.right + 1 && (f.type !== 'checkbox' || f.width >= 16)), label + ' controls fit without inflated icons or squeezed checkboxes', initial);
      for (let i = 0; i < initial.fields.length; i++) {
        const field = `${dialog}.querySelectorAll('input')[${i}]`;
        await evaluate(`${field}.scrollIntoView({block:'center',inline:'nearest'});true`); await sleep(80);
        ensure(await visible(field), label + ' input ' + i + ' can be fully exposed');
      }
      const last = `Array.from(${dialog}.querySelectorAll('button')).filter(e=>!e.disabled).at(-1)`;
      await evaluate(`${last}.scrollIntoView({block:'center'});${last}.focus();true`); await sleep(80);
      ensure(await visible(last), label + ' final action is reachable');
      await key('Tab');
      ensure(await evaluate(`document.activeElement===${dialog}.querySelector('input,button')`) && await visible('document.activeElement'), label + ' Tab wraps to its visible first control');
      await key('Tab', true);
      ensure(await evaluate(`document.activeElement===${last}`) && await visible('document.activeElement'), label + ' Shift Tab returns to the visible final action');
      await key('Escape'); await wait(`!${dialog}`);
      ensure(await evaluate(`document.body.style.position!=='fixed'&&searchFixture.mutations.length===0`), label + ' Escape unlocks the shelf without writing');
    }
  }
  // Record validation separately before product changes, without assuming focus behavior.
  await fresh(); await open('series');
  await fill(`${dialog}.querySelector('input')`, ''); await pointer(action('保存 4 本'));
  const titleValidation = await snapshot();
  console.log('BULK_VALIDATION_OBSERVED', JSON.stringify(titleValidation));
  if (!baseline) {
    ensure(await evaluate(`${dialog}.querySelector('input')===document.activeElement&&document.activeElement.getAttribute('aria-invalid')==='true'`) && await visible('document.activeElement'), 'missing series name focuses the visible invalid field');
    ensure(await visible(`${dialog}.querySelector('[role=alert]')`), 'missing series name shows its explanation beside the input');
    await fill(`${dialog}.querySelector('input')`, '新的系列');
    await fill(`${dialog}.querySelectorAll('input')[3]`, 'not-a-number'); await pointer(action('保存 4 本'));
    ensure(await evaluate(`${dialog}.querySelectorAll('input')[3]===document.activeElement&&document.activeElement.getAttribute('aria-invalid')==='true'`) && await visible('document.activeElement'), 'invalid volume order focuses the exact book field');
    ensure(await visible(`${dialog}.querySelector('[role=alert]')`) && await evaluate(`document.getElementById(document.activeElement.getAttribute('aria-describedby'))===${dialog}.querySelector('[role=alert]')`), 'invalid volume explanation is visible and associated with its input');
    ensure(!(await snapshot()).overflow && await evaluate('searchFixture.mutations.length===0'), 'long-title validation wraps without writing invalid assignments');
    await screenshot('bulk-series-invalid-order');
    for (const [width, height, touch, font, theme, grid] of [[1536, 864, false, 16, 'light', false], [390, 844, true, 16, 'dark', true], [320, 640, true, 32, 'dark', false]]) for (const kind of ['series', 'share', 'delete']) {
      const label = `${kind} ${width}x${height} font${font} ${grid ? 'grid' : 'list'}`;
      await fresh(width, height, touch, font, theme, grid); await open(kind);
      if (kind === 'series') {
        await fill(`${dialog}.querySelectorAll('input')[0]`, '保留的系列名'); await fill(`${dialog}.querySelectorAll('input')[1]`, '保留的类型');
        await fill(`${dialog}.querySelectorAll('input')[3]`, '2.5');
      }
      if (kind === 'share') await pointer(`${dialog}.querySelector('input[type=checkbox]')`);
      const submit = kind === 'series' ? '保存 4 本' : kind === 'share' ? '提交审核' : '确认删除 4 本';
      await evaluate(`searchFixture.holdMutations=true;searchFixture.mutationStatus['bulk-1']=503;window.bulkSubmit=${action(submit)};true`);
      await pointer('window.bulkSubmit'); await wait('searchFixture.pendingMutations.length===4');
      await evaluate('bulkSubmit.click();bulkSubmit.click();true'); await key('Escape');
      ensure(await evaluate(`!!${dialog}&&searchFixture.mutations.length===4&&[...${dialog}.querySelectorAll('input,button')].every(e=>e.disabled)`), label + ' pending batch blocks repeat submission and dismissal');
      const beforeReads = await evaluate('searchFixture.requests.length'); await evaluate('dispatchEvent(new Event("focus"));true'); await sleep(150);
      ensure(await evaluate('searchFixture.requests.length') === beforeReads, label + ' background refresh preserves pending selections');
      await evaluate('searchFixture.holdMutations=false;searchFixture.pendingMutations.splice(0).forEach(r=>r.resolve());true');
      await wait(`!!${dialog}.querySelector('[role=alert]')&&!${dialog}.querySelector('button').disabled`);
      const partial = await snapshot();
      ensure(!partial.overflow && await evaluate(`${dialog}.textContent.includes('1 本')`), label + ' partial failure retains one selected book and readable feedback', partial);
      if (kind === 'series') ensure(await evaluate(`${dialog}.querySelectorAll('input').length===3&&${dialog}.querySelectorAll('input')[0].value==='保留的系列名'&&${dialog}.querySelectorAll('input')[1].value==='保留的类型'&&${dialog}.querySelectorAll('input')[2].value==='2.5'`), label + ' retry keeps the failed book order and series draft');
      if (kind === 'share') ensure(await evaluate(`${dialog}.querySelector('input').checked&&searchFixture.bulkBooks.filter(b=>b.public_status==='pending').every(b=>b.public_download_allowed===true)`), label + ' retry keeps the download setting for remaining books');
      if (kind === 'delete') ensure(await evaluate(`searchFixture.bulkBooks.length===1&&searchFixture.bulkBooks[0].id==='bulk-1'`), label + ' confirmed deletions disappear while the failed book stays');
      await evaluate(`${dialog}.querySelector('[role=alert]').scrollIntoView({block:'center'});true`); await sleep(80); await screenshot('bulk-'+kind+'-partial-'+width);
      await evaluate(`searchFixture.mutationStatus['bulk-1']=0;true`);
      await pointer(action(kind === 'series' ? '保存 1 本' : kind === 'share' ? '提交审核' : '确认删除 1 本')); await wait(`!${dialog}`);
      ensure(await evaluate(`searchFixture.mutations.length===5&&searchFixture.mutations.at(-1).id==='bulk-1'`), label + ' explicit retry writes only the failed book');
    }
    // Removing series membership must not require valid volume orders.
    await fresh(); await open('series'); await fill(`${dialog}.querySelectorAll('input')[2]`, 'invalid'); await pointer(action('移出系列')); await wait(`!${dialog}`);
    ensure(await evaluate(`searchFixture.mutations.length===4&&searchFixture.mutations.every(r=>r.body.series_title===null&&r.body.series_order===null&&r.body.series_kind===null)`), 'remove-series action clears membership without validating discarded order drafts');
  }
  fs.writeFileSync(path.join(reportDir, baseline ? 'bulk-shelf-baseline.json' : 'bulk-shelf-observations.json'), JSON.stringify({ observations, titleValidation }, null, 2));
}
