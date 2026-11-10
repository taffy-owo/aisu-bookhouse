export async function verifyProviderInteractions({ command, evaluate, wait, ensure, input, click, key, fresh, section, action, trigger, loadModels, sleep, shot }) {
  const menu = kind => `document.querySelector('#${kind}-model-options')`;
  const focused = text => `document.activeElement?.getAttribute('role')==='option'&&document.activeElement.textContent.trim()===${JSON.stringify(text)}`;
  const open = async (kind, openingKey = 'Enter') => {
    await evaluate(`${trigger(kind)}.scrollIntoView({block:'center'});${trigger(kind)}.focus({preventScroll:true})`);
    await key(openingKey); await wait(`!!${menu(kind)}`);
  };
  const count = kind => `settingsFixture.requests.filter(r=>r.kind==='${kind}').length`;
  const form = `document.querySelector('form[aria-label="第三方 AI 设置"]')`;
  const submit = () => evaluate(`${form}.requestSubmit()`);
  const doubleClick = expression => evaluate(`(()=>{const b=${expression};b.click();b.click()})()`);
  for (const [width, height, touch, dark, font] of [
    [1536, 864, false, false, 16], [1536, 864, false, true, 16],
    [768, 1024, true, false, 16], [320, 640, true, true, 16],
    [390, 844, true, true, 32], [844, 390, true, false, 16],
  ]) for (const kind of ['translation', 'audiobook']) {
    const label = `${width}x${height} ${dark ? 'dark' : 'light'} ${font}px ${kind}`;
    await fresh(width, height, touch, dark, font); await loadModels(kind); await open(kind);
    ensure(await evaluate(focused('model-20')), label + ' opening focuses the selected model');
    ensure(await evaluate(`(()=>{const r=${menu(kind)}.getBoundingClientRect(),h=document.querySelector('.topbar-shell').getBoundingClientRect(),n=document.querySelector('.mobile-bottom-nav').getBoundingClientRect();return r.top>=Math.max(visualViewport?.offsetTop||0,h.bottom)+7&&r.bottom<=Math.min((visualViewport?.offsetTop||0)+(visualViewport?.height||innerHeight),n.height?n.top:Infinity)-7})()`), label + ' model list stays between the search bar and bottom navigation');
    ensure(await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),m=${menu(kind)}.getBoundingClientRect();return r.top>=m.top&&r.bottom<=m.bottom})()`), label + ' selected option is visible inside the model list');
    await evaluate(`${menu(kind)}.scrollTop=0`); await sleep(80);
    ensure(await evaluate(`${menu(kind)}.scrollTop===0`), label + ' browsing the list does not snap back to the focused model');
    const pageTop = await evaluate('scrollY');
    const initialValue = await evaluate(`document.querySelector('#${kind}-model').value`);
    await key('ArrowDown'); ensure(await evaluate(focused('model-21')), label + ' ArrowDown moves to the next option');
    await key('ArrowUp'); ensure(await evaluate(focused('model-20')), label + ' ArrowUp returns to the previous option');
    await key('End'); ensure(await evaluate(focused('model-40')), label + ' End reaches the final option');
    ensure(await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`), label + ' the final option remains visible and directly clickable');
    await key('Home'); ensure(await evaluate(focused('model-01')), label + ' Home reaches the first option');
    ensure(Math.abs(await evaluate('scrollY') - pageTop) <= 1, label + ' option navigation leaves the surrounding page stationary');
    ensure(await evaluate(`document.querySelector('#${kind}-model').value===${JSON.stringify(initialValue)}`), label + ' navigation keeps the current value until confirmation');
    await key('ArrowDown'); await key('Enter');
    ensure(await evaluate(`!${menu(kind)}&&document.querySelector('#${kind}-model').value==='model-02'&&document.activeElement===${trigger(kind)}`), label + ' Enter selects once, closes and returns focus');
    await open(kind, ' '); await key('ArrowDown'); await key('Escape');
    ensure(await evaluate(`!${menu(kind)}&&document.querySelector('#${kind}-model').value==='model-02'&&document.activeElement===${trigger(kind)}`), label + ' Space opens and Escape cancels with focus restored');
    await open(kind, 'ArrowUp'); await key('Tab');
    ensure(await evaluate(`!${menu(kind)}&&document.activeElement!==document.body&&document.activeElement!==${trigger(kind)}`), label + ' Tab closes the list and continues to the next control');
    await open(kind, 'ArrowDown'); await key('Tab', true);
    ensure(await evaluate(`!${menu(kind)}&&document.activeElement===document.querySelector('#${kind}-model')`), label + ' Shift+Tab closes and returns to the model input');
    await open(kind); await evaluate(`document.querySelector('#${kind}-provider-api-key').focus()`); await sleep(60);
    ensure(await evaluate(`!${menu(kind)}`), label + ' moving focus outside closes the list');
    await click(trigger(kind)); await wait(`!!${menu(kind)}`);
    await click(`${menu(kind)}.querySelector('[role=option]')`);
    ensure(await evaluate(`!${menu(kind)}&&document.querySelector('#${kind}-model').value==='model-01'&&document.activeElement===${trigger(kind)}`), label + ' pointer selection also restores trigger focus');
    ensure(await evaluate('document.documentElement.scrollWidth<=innerWidth'), label + ' model selection fits the viewport');
    if (kind === 'translation' && (width === 320 || width === 1536 && dark)) { await open(kind); await shot(label.replaceAll(' ', '-') + '-models'); await key('Escape'); }
  }
  const longError = '上游返回了完整的连接诊断：' + 'upstream_connection_diagnostic_'.repeat(35) + '；请稍后重试。';
  for (const kind of ['translation', 'audiobook']) for (const text of ['检测连接', '获取模型']) {
    await fresh(320, 640, true); await evaluate(`settingsFixture.hold=true;settingsFixture.fail=true;settingsFixture.error=${JSON.stringify(longError)}`);
    await doubleClick(action(kind, text)); await wait(count(kind) + '>0');
    ensure(await evaluate(count(kind)) === 1, kind + ' ' + text + ' same-turn activation starts one probe');
    ensure(await evaluate(`${action(kind, text === '检测连接' ? '获取模型' : '检测连接')}.disabled`), kind + ' both provider actions wait for the in-flight probe');
    await evaluate('settingsFixture.release()'); await wait(`!!${section(kind)}.querySelector('[role=alert]')`);
    ensure(await evaluate(`${section(kind)}.querySelector('[role=alert]').textContent===${JSON.stringify(longError)}`), kind + ' complete provider error is retained');
    ensure(await evaluate(`(()=>{const e=${section(kind)}.querySelector('[role=alert]');return e.clientWidth<=e.parentElement.clientWidth+1&&e.scrollWidth<=e.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()`), kind + ' provider errors wrap on a narrow screen');
    await evaluate('settingsFixture.fail=false'); await click(action(kind, text));
    await wait(`!!${section(kind)}.querySelector('[role=status]')`);
    ensure(await evaluate(`!${section(kind)}.querySelector('[role=alert]')&&${count(kind)}===2`), kind + ' failure releases the lock so the next attempt succeeds');
  }
  await fresh(); await evaluate('settingsFixture.hold=true;settingsFixture.ignoreAbort=true');
  await click(action('translation', '获取模型')); await click(action('audiobook', '检测连接'));
  ensure(await evaluate(`settingsFixture.requests.length===2&&!settingsFixture.requests.some(r=>r.aborted)`), 'translation and audiobook probes can run independently');
  await input('#translation-provider-base-url', 'https://new.example.local/v1');
  ensure(await evaluate('settingsFixture.requests[0].aborted&&!settingsFixture.requests[1].aborted'), 'editing one provider aborts only its own probe');
  await evaluate('settingsFixture.release()'); await sleep(120);
  ensure(await evaluate(`!${trigger('translation')}&&!${section('translation')}.querySelector('[role=status]')&&!!${section('audiobook')}.querySelector('[role=status]')`), 'late probe results cannot reappear under an edited address');
  await loadModels('translation'); ensure(await evaluate(`!!${trigger('translation')}`), 'edited provider can fetch again after cancellation');
  await input('#translation-provider-api-key', 'local-test-key');
  ensure(await evaluate(`!${trigger('translation')}&&!${section('translation')}.querySelector('[role=status]')`), 'editing the key invalidates the old model list and connection result');
  await evaluate('settingsFixture.hold=true'); await click(action('translation', '获取模型'));
  await evaluate('settingsFixture.refresh()'); await wait(`!${section('translation')}.querySelector('button:disabled')`);
  ensure(await evaluate('settingsFixture.requests.at(-1).aborted'), 'background refresh cancels an in-flight probe');
  await evaluate('settingsFixture.release()'); await sleep(80);
  await loadModels('translation'); ensure(await evaluate(`!!${trigger('translation')}`), 'a background configuration refresh releases cancelled provider requests');

  for (const fail of [false, true]) {
    await fresh(); await evaluate(`settingsFixture.hold=true;settingsFixture.ignoreAbort=true;settingsFixture.fail=${fail}`);
    await click(action('translation', '获取模型')); await evaluate('settingsFixture.switchAccount()');
    await wait(`document.querySelector('#translation-model')?.value==='other-account-model'`);
    await evaluate(`document.querySelector('.settings-disclosure').open=true`);
    ensure(await evaluate('settingsFixture.requests[0].aborted'), 'switching accounts aborts the previous provider probe');
    await evaluate('settingsFixture.release()'); await sleep(120);
    ensure(await evaluate(`!${trigger('translation')}&&!${section('translation')}.querySelector('[role=alert],[role=status]')`), 'late ' + (fail ? 'failure' : 'success') + ' cannot update another account');
    await evaluate('settingsFixture.fail=false'); await loadModels('translation');
    ensure(await evaluate(`!!${trigger('translation')}`), 'new account can probe after old-account cleanup');
  }
  await fresh(); await evaluate('settingsFixture.hold=true;settingsFixture.ignoreAbort=true;settingsFixture.fail=true');
  await click(action('translation', '获取模型')); await evaluate('settingsFixture.navigate("/away")'); await wait('!!document.querySelector("#reopen")');
  ensure(await evaluate('settingsFixture.requests[0].aborted'), 'leaving settings cancels its pending probe');
  await evaluate('settingsFixture.release()'); await click('document.querySelector("#reopen")'); await wait('!!document.querySelector("#translation-model")');
  await evaluate(`document.querySelector('.settings-disclosure').open=true;settingsFixture.fail=false`); await loadModels('translation');
  ensure(await evaluate(`!!${trigger('translation')}`), 'returning to settings permits a fresh model request');

  await fresh(320, 640, true); await input('#translation-model', 'submitted-model');
  await evaluate(`settingsFixture.hold=true;settingsFixture.fail=true;settingsFixture.error=${JSON.stringify(longError)}`);
  await evaluate(`${form}.requestSubmit();${form}.requestSubmit()`); await wait('settingsFixture.requests.some(r=>r.operation==="save")');
  ensure(await evaluate('settingsFixture.requests.filter(r=>r.operation==="save").length===1'), 'same-turn repeated saves write the configuration once');
  await input('#translation-model', 'newer-model'); await evaluate('settingsFixture.release()'); await wait(`${form}.getAttribute('aria-busy')==='false'&&!!${form}.querySelector('[role=alert]')`);
  ensure(await evaluate(`document.querySelector('#translation-model').value==='newer-model'`), 'failed save preserves edits made while it was pending');
  ensure(await evaluate(`(()=>{const e=${form}.querySelector('[role=alert]');return e.clientWidth<=e.parentElement.clientWidth+1&&e.scrollWidth<=e.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()`), 'save errors wrap without displacing the settings page');
  await evaluate('settingsFixture.hold=true;settingsFixture.fail=false'); await submit(); await wait('settingsFixture.requests.filter(r=>r.operation==="save").length===2');
  await input('#translation-model', 'draft-after-submit'); await evaluate('settingsFixture.release()'); await wait(`${form}.getAttribute('aria-busy')==='false'`);
  ensure(await evaluate(`settingsFixture.settings['settings-a'].translation_model==='newer-model'&&document.querySelector('#translation-model').value==='draft-after-submit'`), 'successful save acknowledges its snapshot while keeping later edits');
  await loadModels('translation'); ensure(await evaluate(`!!${trigger('translation')}`), 'saving releases the cancelled probe lock');

  await fresh(); await evaluate('settingsFixture.hold=true;settingsFixture.ignoreAbort=true');
  await click(action('translation', '获取模型')); await input('textarea[aria-label="翻译预设"]', '保存期间保留的预设');
  await submit(); await wait('settingsFixture.requests.some(r=>r.operation==="save")');
  ensure(await evaluate('settingsFixture.requests[0].aborted'), 'saving cancels the active provider probe');
  await evaluate('settingsFixture.release()'); await wait(`${form}.getAttribute('aria-busy')==='false'`);
  await loadModels('translation'); ensure(await evaluate(`!!${trigger('translation')}`), 'a cancelled probe cannot leave model fetching locked after saving');

  await fresh(320, 640, true); await input('#translation-model', 'manual-model');
  await evaluate(`settingsFixture.failReads=true;settingsFixture.error=${JSON.stringify(longError)};settingsFixture.refresh()`);
  await wait(`${form}.textContent.includes('重试同步 AI 设置')`);
  ensure(await evaluate(`document.querySelector('#translation-model').value==='manual-model'`), 'failed background reads preserve the current settings draft');
  ensure(await evaluate(`(()=>{const e=${form}.querySelector('[role=alert] span');return e.clientWidth<=e.parentElement.clientWidth&&e.scrollWidth<=e.clientWidth+1})()`), 'background read errors fit the narrow panel');
  await evaluate('settingsFixture.failReads=false'); await click(`Array.from(${form}.querySelectorAll('button')).find(e=>e.textContent.trim()==='重试同步 AI 设置')`);
  await wait(`!${form}.querySelector('[role=alert]')`);
  ensure(await evaluate(`document.querySelector('#translation-model').value==='manual-model'`), 'retrying a background read also preserves edited fields');
  await loadModels('translation'); await open('translation', 'ArrowDown');
  ensure(await evaluate(focused('model-01')), 'an unlisted model opens at the first option with ArrowDown');
  await key('Escape'); await open('translation', 'ArrowUp');
  ensure(await evaluate(focused('model-40')), 'an unlisted model opens at the last option with ArrowUp');
  await key('Escape'); await open('translation', 'ArrowDown');
  const point = await evaluate(`(()=>{const r=${menu('translation')}.querySelectorAll('[role=option]')[2].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }); await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(100);
  ensure(await evaluate(`!${menu('translation')}&&document.querySelector('#translation-model').value==='model-03'`), 'a real touch selects a visible model and dismisses the list');
  await evaluate('settingsFixture.models=[]'); await click(action('translation', '获取模型')); await wait(`${section('translation')}.textContent.includes('已获取 0 个模型')`);
  ensure(await evaluate(`!${trigger('translation')}&&document.querySelector('#translation-model').value==='model-03'`), 'an empty model response retains the manually editable value');
  await evaluate(`settingsFixture.navigate('/away');settingsFixture.failReads=true`); await wait('!!document.querySelector("#reopen")');
  await click('document.querySelector("#reopen")'); await wait(`!!Array.from(document.querySelectorAll('.settings-disclosure button')).find(e=>e.textContent.trim()==='重试读取 AI 设置')`);
  await evaluate(`document.querySelector('.settings-disclosure').open=true`);
  ensure(await evaluate(`(()=>{const e=document.querySelector('.settings-disclosure [role=alert] p');return e.clientWidth<=e.parentElement.clientWidth&&e.scrollWidth<=e.clientWidth+1})()`), 'initial load errors wrap instead of being clipped');
  await evaluate('settingsFixture.failReads=false'); await click(`Array.from(document.querySelectorAll('.settings-disclosure button')).find(e=>e.textContent.trim()==='重试读取 AI 设置')`);
  await wait('!!document.querySelector("#translation-model")');
  ensure(await evaluate(`document.querySelector('#translation-model').value==='model-20'`), 'initial read failure can be retried without leaving settings');
}
