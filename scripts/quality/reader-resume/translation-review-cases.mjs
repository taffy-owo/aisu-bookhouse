import fs from 'node:fs';
import path from 'node:path';

export async function verifyTranslationReview({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot, baseline, reportDir }) {
  const dialog = `document.querySelector('.translation-review-dialog')`;
  const button = text => `Array.from(${dialog}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const opener = `Array.from(document.querySelectorAll('#book-translation-status button')).find(e=>e.textContent.includes('查看并审核'))`;
  const visible = expression => evaluate(`(()=>{const e=${expression},r=e.getBoundingClientRect(),v=visualViewport;return r.left>=(v?.offsetLeft||0)&&r.right<=(v?.offsetLeft||0)+(v?.width||innerWidth)+1&&r.top>=(v?.offsetTop||0)&&r.bottom<=(v?.offsetTop||0)+(v?.height||innerHeight)+1&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
  const pointer = async expression => {
    await evaluate(`${expression}.scrollIntoView({block:'center',inline:'nearest'});true`); await sleep(100);
    if (!await visible(expression)) throw Error('Covered review target: ' + expression);
    await click(expression);
  };
  const key = async (name, shift = false) => {
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: { Tab: 9, Escape: 27, Enter: 13 }[name], modifiers: shift ? 8 : 0 });
    await sleep(80);
  };
  const reset = async (width = 1536, height = 864, touch = false, font = 16, dark = false, long = false) => {
    await command('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await fresh(width, height, touch, 'detail&translationReview' + (dark ? '&siteDark' : '') + (long ? '&reviewLong' : ''), false);
    await wait(`document.querySelector('.book-detail-page')?.dataset.navigationLoading==='false'&&!!${opener}`);
    await evaluate(`document.documentElement.style.fontSize='${font}px';document.fonts.ready.then(()=>true)`); await sleep(140);
  };
  const open = async () => { await pointer(opener); await wait(`!!${dialog}`); await sleep(160); };
  const snapshot = () => evaluate(`(()=>{const d=${dialog},v=visualViewport,rect=e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};const body=d.querySelector('.translation-review-content'),p=d.querySelector('details p'),style=p&&getComputedStyle(p);return{dialog:rect(d),viewport:{top:v?.offsetTop||0,left:v?.offsetLeft||0,width:v?.width||innerWidth,height:v?.height||innerHeight},overflow:d.scrollWidth>d.clientWidth+1,portalOverflow:d.parentElement.scrollWidth>d.parentElement.clientWidth+1,close:rect(d.querySelector('button')),icons:[...d.querySelectorAll('button svg')].map(rect),header:rect(d.querySelector('header')),footer:rect(d.querySelector('footer')),body:rect(body),bodyScroll:body.scrollTop,flow:d.dataset.reviewFlow,proseFont:style&&parseFloat(style.fontSize),lineHeight:style&&parseFloat(style.lineHeight),paragraphs:d.querySelectorAll('details[open] p').length,open:[...d.querySelectorAll('details')].map(e=>e.open)}})()`);
  const observations = [];
  const cases = process.env.REVIEW_INTERACTIONS_ONLY ? [] : [
    [1536, 864, false, 16, false, false, 1], [1536, 864, false, 16, true, true, 1],
    [390, 844, true, 16, true, false, 1], [768, 1024, true, 16, false, true, 1],
    [320, 640, true, 32, true, true, 1], [844, 390, true, 32, false, false, 1],
    [320, 280, true, 32, true, true, 1], [1536, 900, false, 32, false, true, 1.5],
  ];
  for (const [width, height, touch, font, dark, long, scale] of cases) {
    await reset(width, height < 300 ? 640 : height, touch, font, dark, long); await open();
    if (height < 300) { await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch }); await sleep(160); }
    if (scale !== 1) { await command('Emulation.setPageScaleFactor', { pageScaleFactor: scale }); await sleep(200); }
    const label = `${width}x${height} font${font} ${dark ? 'dark' : 'light'} ${long ? 'long' : 'normal'} scale${scale}`;
    const initial = await snapshot(); observations.push({ label, initial }); console.log('REVIEW_OBSERVED', JSON.stringify(observations.at(-1)));
    await screenshot(`translation-review-${width}-${height}-${font}-${scale}${baseline ? '-baseline' : ''}`);
    if (!baseline) {
      const r = initial.dialog, v = initial.viewport;
      ensure(!initial.overflow && !initial.portalOverflow && r.left >= v.left && r.right <= v.left + v.width + 1 && r.top >= v.top && r.bottom <= v.top + v.height + 1, label + ' long preview fits the visible viewport', initial);
      ensure(initial.close.width === 44 && initial.close.height === 44 && initial.icons.every(i => i.width <= 16 && i.height <= 16), label + ' close control and icons stay compact', initial);
      ensure(initial.proseFont >= (font === 32 ? 28 : 15) && initial.lineHeight / initial.proseFont <= 2.05, label + ' preview prose scales with text size and keeps proportionate leading', initial);
      if (width === 1536 && font === 16 && !long) ensure(initial.flow === 'false' && initial.body.height >= 200 && initial.footer.bottom <= v.top + v.height && initial.footer.top >= v.top, 'normal review retains a scrollable preview and visible footer');
      const lastParagraph = `Array.from(${dialog}.querySelectorAll('details[open] p')).at(-1)`;
      await evaluate(`${lastParagraph}.scrollIntoView({block:'end'});true`); await sleep(100);
      const finalLine = await evaluate(`(()=>{const p=${lastParagraph},text=p.lastChild,range=document.createRange();range.setStart(text,Math.max(0,text.length-1));range.setEnd(text,text.length);const r=range.getBoundingClientRect(),v=visualViewport;return{top:r.top,bottom:r.bottom,visible:r.top>=(v?.offsetTop||0)&&r.bottom<=(v?.offsetTop||0)+(v?.height||innerHeight)+1&&p.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}})()`);
      ensure(finalLine.visible, label + ' final preview line can be exposed even when a paragraph exceeds the short viewport', finalLine);
      const source = `${dialog}.querySelector('details[open] a')`;
      await evaluate(`${source}.scrollIntoView({block:'center'});true`); await sleep(90);
      ensure(await visible(source) && await evaluate(`${source}.href.startsWith('https://kakuyomu.jp/')&&${source}.rel.includes('noreferrer')&&${source}.target==='_blank'`), label + ' original source remains reachable');
      const last = button('接受并加入 3 话');
      await evaluate(`${last}.scrollIntoView({block:'center'});${last}.focus();true`); await sleep(80);
      ensure(await visible(last), label + ' accept action is reachable');
      await key('Tab');
      ensure(await evaluate(`document.activeElement===${dialog}.querySelector('button')`) && await visible('document.activeElement'), label + ' Tab wraps to its visible close control');
      await key('Tab', true);
      ensure(await evaluate(`document.activeElement===${last}`) && await visible('document.activeElement'), label + ' reverse Tab returns to the accept action');
      await key('Escape'); await wait(`!${dialog}`);
      ensure(await evaluate(`document.body.style.position!=='fixed'&&!new URLSearchParams(location.search).has('translationReview')&&resumeFixture.reviewRequests.every(r=>r.method==='GET')`), label + ' dismissal returns to the book without changing the draft');
    }
  }
  if (!baseline) {
    await reset(); await open();
    await evaluate(`${dialog}.querySelector('.translation-review-content').scrollTop=1000;true`); await sleep(120);
    const visibleParagraph = () => evaluate(`(()=>{const d=${dialog},flow=d.dataset.reviewFlow==='true',r=(flow?d:d.querySelector('.translation-review-content')).getBoundingClientRect();return [...d.querySelectorAll('details[open] p')].findIndex(p=>p.getBoundingClientRect().bottom>r.top+2&&p.getBoundingClientRect().top<r.bottom-2)})()`);
    const beforeResize = await visibleParagraph();
    await command('Emulation.setDeviceMetricsOverride', { width: 1536, height: 260, deviceScaleFactor: 1, mobile: false }); await sleep(180);
    const shortResize = await visibleParagraph();
    await command('Emulation.setDeviceMetricsOverride', { width: 1536, height: 864, deviceScaleFactor: 1, mobile: false }); await sleep(180);
    const restoredResize = await visibleParagraph();
    console.log('REVIEW_RESIZE_OBSERVED', JSON.stringify({ beforeResize, shortResize, restoredResize }));
    if (!process.env.REVIEW_TRANSITION_BASELINE) ensure(beforeResize >= 0 && shortResize === beforeResize && restoredResize === beforeResize, 'switching between preview scrolling and compact dialog scrolling preserves the visible paragraph', { beforeResize, shortResize, restoredResize });
    for (const [width, height, touch, font, dark] of [[1536, 864, false, 16, false], [320, 640, true, 32, true]]) for (const operation of ['accept', 'reject']) {
      const label = `${operation} ${width}x${height} font${font}`;
      await reset(width, height, touch, font, dark); await open();
      await pointer(`${dialog}.querySelectorAll('summary')[1]`);
      ensure(await evaluate(`${dialog}.querySelectorAll('details')[1].open&&${dialog}.querySelectorAll('details')[1].querySelectorAll('p').length===60`), label + ' native chapter disclosure reveals the complete preview');
      if (operation === 'reject') {
        await evaluate('resumeFixture.confirmedReview=false'); await pointer(button('放弃这批译稿'));
        ensure(await evaluate(`resumeFixture.confirmCalls.length===1&&resumeFixture.reviewRequests.every(r=>r.operation!=='reject')&&!!${dialog}`), label + ' declining confirmation keeps the draft without a write');
        await evaluate('resumeFixture.confirmedReview=true');
      }
      const submit = button(operation === 'accept' ? '接受并加入 3 话' : '放弃这批译稿');
      await evaluate(`resumeFixture.holdReview.${operation}=true;resumeFixture.reviewStatus.${operation}=503;window.reviewSubmit=${submit};true`);
      await pointer('window.reviewSubmit'); await wait(`resumeFixture.pendingReviews.some(r=>r.operation==='${operation}')`);
      await evaluate('reviewSubmit.click();reviewSubmit.click();true'); await key('Escape');
      ensure(await evaluate(`!!${dialog}&&resumeFixture.reviewRequests.filter(r=>r.operation==='${operation}').length===1&&[...${dialog}.querySelectorAll('button')].every(e=>e.disabled)`), label + ' pending action blocks duplicate writes and dismissal');
      await evaluate(`resumeFixture.holdReview.${operation}=false;resumeFixture.pendingReviews.splice(0).forEach(r=>r.resolve());true`);
      await wait(`!!${dialog}.querySelector('[role=alert]')&&!reviewSubmit.disabled`);
      ensure(await evaluate(`${dialog}.querySelectorAll('details')[1].open&&${dialog}.querySelectorAll('details')[1].querySelectorAll('p').length===60&&getComputedStyle(${dialog}.querySelector('[role=alert]')).whiteSpace==='pre-wrap'`) && !(await snapshot()).overflow, label + ' failure keeps expanded chapters and readable diagnostics');
      await evaluate(`${dialog}.querySelector('[role=alert]').scrollIntoView({block:'center'});true`); await screenshot('translation-review-' + operation + '-failed-' + width);
      await evaluate(`resumeFixture.reviewStatus.${operation}=0;true`); await pointer('window.reviewSubmit'); await wait(`!${dialog}`);
      ensure(await evaluate(`resumeFixture.reviewRequests.filter(r=>r.operation==='${operation}').length===2&&resumeFixture.reviewJob.status==='${operation === 'accept' ? 'ready' : 'rejected'}'`), label + ' explicit retry performs one additional action and updates the task');
    }
    await reset(); await evaluate('resumeFixture.holdReview.review=true'); await pointer(opener);
    await wait('resumeFixture.pendingReviews.length===1');
    const loading = `document.querySelector('#book-translation-status button[aria-busy="true"]')`;
    ensure(await evaluate(`${loading}?.disabled&&${loading}.textContent.includes('正在读取译稿')`), 'slow review reads explain their loading state');
    await evaluate(`${loading}.click();${loading}.click();true`);
    ensure(await evaluate('resumeFixture.reviewRequests.length===1'), 'repeat clicks while reading do not restart the request');
    await evaluate('resumeFixture.holdReview.review=false;resumeFixture.pendingReviews.splice(0).forEach(r=>r.resolve());true'); await wait(`!!${dialog}`);
    ensure(await evaluate('resumeFixture.reviewRequests.every(r=>r.method==="GET")'), 'slow review opens after its read without any write');
    await reset(); await evaluate("resumeFixture.review.book_id='another-book'"); await pointer(opener);
    await wait("document.body.textContent.includes('这份译稿不属于当前图书')&&!new URLSearchParams(location.search).has('translationReview')");
    ensure(await evaluate(`!${dialog}&&resumeFixture.reviewRequests.every(r=>r.method==='GET')`), 'a review for another book is rejected before showing or writing it');
    for (const status of ['ready', 'rejected', 'processing']) {
      await reset(); await evaluate(`resumeFixture.review.status='${status}'`); await open();
      ensure(await evaluate(`[...${dialog}.querySelectorAll('footer button[aria-busy]')].every(e=>e.disabled)&&${dialog}.querySelector('#translation-draft-description').textContent.includes('${status === 'ready' ? '已加入原书' : status === 'rejected' ? '已放弃' : '尚未进入审核'}')`), status + ' review explains its current status and cannot submit obsolete actions');
    }
    await reset(); await evaluate('resumeFixture.review.chapters=[]'); await open();
    ensure(await evaluate(`${dialog}.textContent.includes('暂无可预览的译稿')&&${button('接受并加入 0 话')}.disabled`), 'empty review has a visible explanation and cannot be accepted');
    await reset(); await evaluate('resumeFixture.reviewStatus.review=503'); await pointer(opener);
    await wait(`document.body.textContent.includes('模拟译稿操作失败')&&!new URLSearchParams(location.search).has('translationReview')`);
    ensure(await evaluate(`!${dialog}&&resumeFixture.reviewRequests.every(r=>r.method==='GET')&&document.documentElement.scrollWidth<=innerWidth`), 'failed review read returns to the book with feedback and performs no write');
    const failedReadCount = await evaluate('resumeFixture.reviewRequests.length');
    await evaluate('resumeFixture.reviewStatus.review=0'); await open();
    ensure(await evaluate('resumeFixture.reviewRequests.length') === failedReadCount + 1, 'reopening after a read failure retries only the review GET');
  }
  fs.writeFileSync(path.join(reportDir, baseline ? 'translation-review-baseline.json' : 'translation-review-observations.json'), JSON.stringify({ observations }, null, 2));
}
