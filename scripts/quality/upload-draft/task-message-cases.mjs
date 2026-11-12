/** Exercise real TranslationPage diagnostics, task controls and retained submission settings. */
export async function verifyTaskMessages({ command, evaluate, wait, ensure, sleep, fresh, shot }) {
  const row = id => `Array.from(document.querySelectorAll('[role=group][aria-label]')).find(e=>e.getAttribute('aria-label')===${JSON.stringify('《' + id + '》翻译任务')})`;
  const failed = `Array.from(document.querySelectorAll('[role=group][aria-label]')).find(e=>e.getAttribute('aria-label').startsWith('《翻译失败的长书名'))`;
  const submission = `document.querySelector('[data-translation-submission]')`;
  const key = async (key) => {
    const code = key === ' ' ? 'Space' : key, windowsVirtualKeyCode = { Enter: 13, ' ': 32, PageDown: 34 }[key];
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text: key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    await sleep(100);
  };
  const activate = async (expression, touch) => {
    const point = await evaluate(`(()=>{const e=${expression};for(let p=e.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS'&&!(e.tagName==='SUMMARY'&&p===e.parentElement))p.open=true;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (touch) {
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    }
    await sleep(150);
  };
  const inspectDiagnostic = async (owner, label, touch) => {
    const disclosure = `${owner}.querySelector('[data-task-error] details')`;
    await wait(`!!${disclosure}`);
    ensure(await evaluate(`!${disclosure}.open`), label + ' long diagnostic starts collapsed');
    await activate(`${disclosure}.querySelector('summary')`, touch);
    const text = `${disclosure}.querySelector('[role=region]')`;
    ensure(await evaluate(`${disclosure}.open&&${text}.textContent.includes(draftFixture.diagnostic)&&${text}.scrollWidth<=${text}.clientWidth+1&&${text}.clientHeight<=160`), label + ' expanded diagnostic preserves every character within a bounded wrapping region');
    const scrollable = await evaluate(`${text}.scrollHeight>${text}.clientHeight`);
    ensure(await evaluate(`${text}.tabIndex===0&&${text}.getAttribute('aria-label')==='错误详情全文'`), label + ' the complete diagnostic has a named keyboard focus target');
    await evaluate(`${text}.focus({preventScroll:true});${text}.scrollTop=0`); await key('PageDown'); await sleep(200);
    ensure(await evaluate(`document.activeElement===${text}&&(${scrollable ? `${text}.scrollTop>0` : `${text}.scrollHeight===${text}.clientHeight`})`), label + (scrollable ? ' keyboard paging scrolls the focused diagnostic' : ' a fitting diagnostic remains fully visible and keyboard focused'));
    await evaluate(`${disclosure}.querySelector('summary').scrollIntoView({block:'center'});${disclosure}.querySelector('summary').focus({preventScroll:true})`); await key(' ');
    ensure(await evaluate(`!${disclosure}.open&&document.activeElement===${disclosure}.querySelector('summary')`), label + ' Space closes diagnostic details without losing focus');
  };
  for (const [width, height, touch, dark] of [[320, 568, true, false], [390, 844, true, true], [768, 1024, true, false], [1024, 600, true, true], [1536, 864, false, false], [1536, 864, false, true]]) {
    const label = width + ' task messages ' + (dark ? 'dark' : 'light');
    console.log('CHECK ' + label);
    await fresh('taskMessages' + (dark ? '&dark' : ''), width, height, touch);
    await wait(`!!(${failed})&&!!${submission}`);
    const geometry = await evaluate(`(()=>{const e=${failed};return{height:e.getBoundingClientRect().height,width:e.clientWidth,scrollWidth:e.scrollWidth,viewport:innerWidth}})()`);
    ensure(geometry.scrollWidth <= geometry.width + 1 && geometry.height < 460, label + ' long failed-job diagnostics fit a compact task row', geometry);
    await inspectDiagnostic(failed, label + ' failed job', touch);
    await inspectDiagnostic(row('waiting'), label + ' waiting quota', touch);
    ensure(await evaluate(`${row('failed-short')}.textContent.includes('网络暂时不可用，请稍后重试。')&&!${row('failed-short')}.querySelector('[data-task-error] details')`), label + ' short errors remain fully visible without another disclosure');
    ensure(await evaluate(`${row('processing')}.textContent.includes('正在翻译第 5 话')&&!!${row('processing')}.querySelector('[data-task-focus-control=pause]')`), label + ' normal progress and its pause action remain visible');
    ensure(await evaluate(`${row('review')}.querySelector('a').getAttribute('href').includes('translationReview=review')`), label + ' completed review still opens its actual draft');

    await activate(`${row('paused')}.querySelector('[title=继续翻译]')`, touch);
    await wait(`!!${row('paused')}.querySelector('[role=alert]')`);
    await inspectDiagnostic(row('paused'), label + ' action error', touch);
    await evaluate('draftFixture.translationActionStatus=200'); await activate(`${row('paused')}.querySelector('[title=继续翻译]')`, touch);
    await wait(`${row('paused')}.textContent.includes('已加入队列')`);
    ensure(await evaluate(`!${row('paused')}.querySelector('[role=alert]')&&draftFixture.translationActions.length===2`), label + ' successful retry clears only the obsolete action error');

    await inspectDiagnostic(submission, label + ' unconfirmed submission', touch);
    await activate(`Array.from(${submission}.querySelectorAll('button')).find(e=>e.textContent.includes('按原设置重试'))`, touch);
    await wait(`${submission}.textContent.includes('未确认加入')&&draftFixture.translationSubmissions.length===1`);
    ensure(await evaluate(`draftFixture.translationSubmissions[0].model==='original-model'&&draftFixture.translationSubmissions[0].custom_instructions==='保留人物称呼与段落。'&&draftFixture.translationSubmissions[0].request_concurrency===3`), label + ' submission retry retains the exact original settings');
    await inspectDiagnostic(submission, label + ' retried submission', touch);
    await evaluate('draftFixture.translationSubmitStatus=200'); await activate(`Array.from(${submission}.querySelectorAll('button')).find(e=>e.textContent.includes('按原设置重试'))`, touch);
    await wait(`!${submission}`);
    ensure(await evaluate('draftFixture.translationSubmissions.length===2&&document.body.textContent.includes("已确认提交的译稿")'), label + ' an acknowledged submission removes its local diagnostic and appears as a server job');
    ensure(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&Array.from(document.querySelectorAll('[role=group][aria-label$=翻译任务]')).every(e=>e.scrollWidth<=e.clientWidth+1)`), label + ' all task states stay within their column');
    await evaluate(`${failed}.scrollIntoView({block:'center'})`); await shot('task-diagnostics-' + width + '-' + (dark ? 'dark' : 'light'));
  }
}
