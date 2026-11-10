const section = `document.querySelector('[aria-label="翻译渠道设置"]')`;
const row = id => `Array.from(${section}?.querySelectorAll('[data-channel-id]')||[]).find(e=>e.dataset.channelId===${JSON.stringify(id)})`;
const form = index => `${section}.querySelectorAll('form')[${index}]`;
const button = (editor, text) => `Array.from(${editor}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
const open = (click, id) => click(`${row(id)}.querySelector('[data-channel-action=edit]')`);
const inputIn = async (evaluate, input, editor, field, value) => input(await evaluate(`'#'+CSS.escape(${editor}.querySelector('[data-validation-field="${field}"]').id)`), value);

export async function probeChannelEditors({ fresh, evaluate, input, click, wait, sleep, observations }) {
  await fresh(); await open(click, 'settings-a-0');
  await inputIn(evaluate, input, form(0), 'name', '失败后保留的草稿');
  await evaluate(`settingsFixture.channelFail=true;settingsFixture.error='保存失败的完整提示'`);
  await click(button(form(0), '保存修改')); await wait(`!!${form(0)}.querySelector('[role=alert]')`);
  const failedSaveFocus = await evaluate('document.activeElement?.tagName');
  await evaluate('settingsFixture.channelFail=false'); await click(button(form(0), '重新读取并保留编辑'));
  await sleep(150);
  observations.push({ failedSaveFocus, staleErrorAfterSameRevision: await evaluate(`!!${form(0)}.querySelector('[role=alert]')`), draft: await evaluate(`${form(0)}.querySelector('[data-validation-field=name]').value`) });

  await fresh(); await open(click, 'settings-a-0'); await open(click, 'settings-a-1');
  await inputIn(evaluate, input, form(0), 'name', '并行保存主渠道');
  await inputIn(evaluate, input, form(1), 'name', '并行保存备用渠道');
  await evaluate('settingsFixture.channelHold=true');
  await click(button(form(0), '保存修改')); await click(button(form(1), '保存修改'));
  await wait('settingsFixture.channelPending.length===2');
  await evaluate('settingsFixture.channelPending.shift()()'); await wait(`!!${row('settings-a-0')}`);
  const focusAfterFirst = await evaluate(`document.activeElement?.closest('[data-channel-id]')?.dataset.channelId||document.activeElement?.tagName`);
  await evaluate('settingsFixture.channelPending.shift()()'); await wait(`${section}.querySelectorAll('form').length===0`); await sleep(100);
  observations.push({ focusAfterFirst, focusAfterLast: await evaluate(`document.activeElement?.closest('[data-channel-id]')?.dataset.channelId||document.activeElement?.tagName`) });
}

export async function verifyChannelEditors({ fresh, evaluate, input, click, wait, sleep, ensure, shot, key, command }) {
  for (const [width, height, touch, dark] of [[1536, 864, false, true], [768, 1024, true, false], [320, 640, true, true]]) {
    const label = width + ' editor recovery';
    await fresh(width, height, touch, dark); await open(click, 'settings-a-0');
    await inputIn(evaluate, input, form(0), 'name', '失败后保留的草稿');
    await evaluate(`settingsFixture.channelFail=true;settingsFixture.error='保存失败的完整提示'`);
    await click(button(form(0), '保存修改')); await wait(`!!${form(0)}.querySelector('[role=alert]')`);
    await wait(`document.activeElement===${button(form(0), '保存修改')}`);
    ensure(await evaluate(`document.activeElement===${button(form(0), '保存修改')}`), label + ' failed saves return focus after the fieldset is enabled');
    await evaluate('settingsFixture.channelFail=false;settingsFixture.channelFailReads=true');
    await click(button(form(0), '重新读取并保留编辑')); await wait(`${section}.textContent.includes('重试同步渠道')`);
    ensure(await evaluate(`!!${form(0)}.querySelector('[role=alert]')&&${form(0)}.querySelector('[data-validation-field=name]').value==='失败后保留的草稿'`), label + ' failed reloads preserve the unresolved error and draft');
    await evaluate('settingsFixture.channelFailReads=false'); await click(button(form(0), '重新读取并保留编辑'));
    await wait(`!${form(0)}.querySelector('[role=alert]')`); await wait(`document.activeElement===${button(form(0), '保存修改')}`);
    ensure(await evaluate(`${form(0)}.querySelector('[data-validation-field=name]').value==='失败后保留的草稿'&&settingsFixture.channelConfigs['settings-a'][0].name==='主翻译渠道'`), label + ' a successful same-version read clears old errors without saving or losing the draft');
    ensure(await evaluate(`document.activeElement===${button(form(0), '保存修改')}`), label + ' dismissing the reload control returns to Save');
    if (width === 320) await shot('channel-editor-reload-recovered-narrow');
    await click(button(form(0), '保存修改')); await wait(`!${form(0)}`);
    await wait(`document.activeElement===${row('settings-a-0')}.querySelector('[data-channel-action=edit]')`);
    ensure(await evaluate(`settingsFixture.channelConfigs['settings-a'][0].name==='失败后保留的草稿'`), label + ' retry saves the preserved draft with the correct row focus');

    await open(click, 'settings-a-0'); await inputIn(evaluate, input, form(0), 'name', '本地冲突草稿');
    await evaluate(`settingsFixture.updateChannel({name:'远端名称',base_url:'https://remote.example.local/v1'})`);
    await click(button(form(0), '保存修改')); await wait(`${form(0)}.textContent.includes('渠道已被其他操作更新')`);
    await click(button(form(0), '重新读取并保留编辑')); await wait(`${form(0)}.textContent.includes('渠道资料已同步')&&!${form(0)}.querySelector('[role=alert]')`);
    ensure(await evaluate(`${form(0)}.querySelector('[data-validation-field=name]').value==='本地冲突草稿'&&${form(0)}.querySelector('[data-validation-field=baseUrl]').value==='https://remote.example.local/v1'`), label + ' revision recovery keeps edited fields and merges untouched remote values');
    ensure(await evaluate(`document.activeElement===${button(form(0), '保存修改')}`), label + ' conflict recovery preserves keyboard continuity');

    for (const [firstResult, failFirst, failLast] of [[0, false, false], [1, false, false], [0, true, false], [0, false, true]]) {
      await fresh(width, height, touch, dark); await open(click, 'settings-a-0'); await open(click, 'settings-a-1');
      await evaluate(`settingsFixture.editorForms=Array.from(${section}.querySelectorAll('form'));settingsFixture.channelHold=true`);
      const editor = index => `settingsFixture.editorForms[${index}]`;
      await inputIn(evaluate, input, editor(0), 'name', '并行主渠道'); await inputIn(evaluate, input, editor(1), 'name', '并行备用渠道');
      await evaluate(`settingsFixture.channelFail=${failFirst}`); await click(button(editor(0), '保存修改'));
      await evaluate(`settingsFixture.channelFail=${failLast}`); await click(button(editor(1), '保存修改'));
      await wait('settingsFixture.channelPending.length===2');
      const tag = `${width} parallel ${firstResult} ${failFirst}/${failLast}`;
      ensure(await evaluate(`${editor(0)}.getAttribute('aria-busy')==='true'&&${editor(1)}.getAttribute('aria-busy')==='true'`), tag + ' both editors save independently');
      await evaluate(`settingsFixture.channelPending.splice(${firstResult},1)[0]()`);
      await wait(`!${editor(firstResult)}.isConnected||${editor(firstResult)}.getAttribute('aria-busy')==='false'`);
      if (firstResult === 0) ensure(await evaluate('document.activeElement===document.body'), tag + ' an earlier action cannot reclaim focus while the later editor is busy');
      await evaluate('settingsFixture.channelPending.shift()()');
      await wait(`!${editor(1 - firstResult)}.isConnected||${editor(1 - firstResult)}.getAttribute('aria-busy')==='false'`);
      const expectedFocus = failLast ? button(editor(1), '保存修改') : `${row('settings-a-1')}.querySelector('[data-channel-action=edit]')`;
      await wait(`document.activeElement===${expectedFocus}`);
      ensure(await evaluate(`document.activeElement===${expectedFocus}`), tag + ' completion order never overrides the last interacted editor');
      ensure(await evaluate(`settingsFixture.channelConfigs['settings-a'][0].name===${JSON.stringify(failFirst ? '主翻译渠道' : '并行主渠道')}&&settingsFixture.channelConfigs['settings-a'][1].name===${JSON.stringify(failLast ? '备用渠道' : '并行备用渠道')}`), tag + ' each response only commits its own successful write');
      if (failFirst || failLast) {
        const index = failFirst ? 0 : 1;
        ensure(await evaluate(`${editor(index)}.querySelector('[data-validation-field=name]').value===${JSON.stringify(index ? '并行备用渠道' : '并行主渠道')}&&!!${editor(index)}.querySelector('[role=alert]')`), tag + ' the failed editor retains its own draft and diagnostic');
      }
    }
  }

  await fresh(); await open(click, 'settings-a-0'); await inputIn(evaluate, input, form(0), 'name', '读取前后的草稿');
  await evaluate(`settingsFixture.channelHoldReads=true;settingsFixture.refreshChannels();settingsFixture.channelFail=true`);
  await wait('settingsFixture.channelPendingReads.length===1'); await click(button(form(0), '保存修改'));
  await wait(`!!${form(0)}.querySelector('[role=alert]')`);
  await evaluate('settingsFixture.releaseChannelReads()'); await sleep(150);
  ensure(await evaluate(`!!${form(0)}.querySelector('[role=alert]')`), 'a read started before a save failure cannot acknowledge that newer error');
  await evaluate('settingsFixture.refreshChannels()'); await wait(`!${form(0)}.querySelector('[role=alert]')`);
  ensure(await evaluate(`${form(0)}.querySelector('[data-validation-field=name]').value==='读取前后的草稿'`), 'a later background read acknowledges the error while preserving the draft');

  for (const target of ['search', 'heading']) {
    await fresh(); await open(click, 'settings-a-0'); await inputIn(evaluate, input, form(0), 'name', '其他位置的焦点');
    await evaluate('settingsFixture.channelHold=true'); await click(button(form(0), '保存修改'));
    await click(target === 'search' ? `document.querySelector('[aria-label="搜索书名、作者"]')` : `${section}.querySelector('h2')`);
    await evaluate('settingsFixture.releaseChannels()'); await wait(`!${form(0)}`);
    ensure(await evaluate(target === 'search' ? `document.activeElement===document.querySelector('[aria-label="搜索书名、作者"]')` : 'document.activeElement===document.body'), target + ' interaction outside the saving editor prevents automatic focus theft');
  }

  await fresh(); await open(click, 'settings-a-0'); await inputIn(evaluate, input, form(0), 'name', '键盘提交的草稿');
  await evaluate(`settingsFixture.channelFail=true;${form(0)}.querySelector('[data-validation-field=name]').focus()`); await key('Enter');
  await wait(`!!${form(0)}.querySelector('[role=alert]')`);
  ensure(await evaluate(`document.activeElement===${form(0)}.querySelector('[data-validation-field=name]')`), 'failed keyboard submissions restore the original input focus');

  for (const fail of [false, true]) {
    await fresh(390, 844, true, false); await open(click, 'settings-a-0'); await inputIn(evaluate, input, form(0), 'name', '触屏保存的草稿');
    await evaluate(`settingsFixture.channelHold=true;settingsFixture.channelFail=${fail}`);
    const point = await evaluate(`(()=>{const e=${button(form(0), '保存修改')};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }); await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait('settingsFixture.channelPending.length===1'); await evaluate('settingsFixture.releaseChannels()');
    const target = fail ? button(form(0), '保存修改') : `${row('settings-a-0')}.querySelector('[data-channel-action=edit]')`;
    await wait(fail ? `!!${form(0)}.querySelector('[role=alert]')` : `!${form(0)}`); await wait(`document.activeElement===${target}`);
    ensure(await evaluate(`document.activeElement===${target}`), 'real touch save ' + (fail ? 'failure' : 'success') + ' keeps the intended action focus');
  }

  for (const [firstAction, lastAction] of [['probe', 'save'], ['save', 'probe'], ['toggle', 'save']]) {
    await fresh(); if (firstAction !== 'toggle') await open(click, 'settings-a-0'); await open(click, 'settings-a-1');
    await evaluate(`settingsFixture.firstEditor=${firstAction === 'toggle' ? 'null' : form(0)};settingsFixture.secondEditor=Array.from(${section}.querySelectorAll('form')).at(-1);settingsFixture.channelHold=true`);
    if (firstAction === 'save') await inputIn(evaluate, input, 'settingsFixture.firstEditor', 'name', '混合操作主渠道');
    if (lastAction === 'save') await inputIn(evaluate, input, 'settingsFixture.secondEditor', 'name', '混合操作备用渠道');
    await click(firstAction === 'toggle' ? `${row('settings-a-0')}.querySelector('[data-channel-action=toggle]')` : button('settingsFixture.firstEditor', firstAction === 'save' ? '保存修改' : '获取模型列表'));
    await click(button('settingsFixture.secondEditor', lastAction === 'save' ? '保存修改' : '获取模型列表'));
    await wait('settingsFixture.channelPending.length===2'); await evaluate('settingsFixture.channelPending.shift()()');
    await wait(firstAction === 'probe' ? `settingsFixture.firstEditor.textContent.includes('已获取最新模型列表')` : firstAction === 'save' ? '!settingsFixture.firstEditor.isConnected' : `!settingsFixture.channelConfigs['settings-a'][0].enabled`);
    ensure(await evaluate('document.activeElement===document.body'), firstAction + '/' + lastAction + ' earlier completion leaves the later action focus alone');
    await evaluate('settingsFixture.channelPending.shift()()');
    const target = lastAction === 'save' ? `${row('settings-a-1')}?.querySelector('[data-channel-action=edit]')` : button('settingsFixture.secondEditor', '获取模型列表');
    await wait(`document.activeElement===${target}`);
    ensure(await evaluate(`document.activeElement===${target}`), firstAction + '/' + lastAction + ' restores only the last action when it finishes');
  }

  await fresh(); await evaluate('settingsFixture.channelFail=true'); await click(`${row('settings-a-0')}.querySelector('[data-channel-action=toggle]')`);
  await wait(`!!${row('settings-a-0')}.querySelector('[role=alert]')`); await evaluate('settingsFixture.channelFail=false');
  await open(click, 'settings-a-1'); await inputIn(evaluate, input, form(0), 'name', '重读期间保存的草稿');
  await evaluate('settingsFixture.channelHoldReads=true;settingsFixture.channelHold=true');
  await click(button(row('settings-a-0'), '重新读取渠道')); await click(button(form(0), '保存修改'));
  await evaluate('settingsFixture.releaseChannelReads()'); await wait(`!${row('settings-a-0')}.querySelector('[role=alert]')`);
  ensure(await evaluate('document.activeElement===document.body'), 'a disappearing row-reload control cannot steal focus from a later pending save');
  await evaluate('settingsFixture.releaseChannels()'); await wait(`!${form(0)}`);
  await wait(`document.activeElement===${row('settings-a-1')}.querySelector('[data-channel-action=edit]')`);

  await fresh(); await click(button(section, '添加渠道'));
  for (const [field, value] of [['name', '尚未创建的草稿'], ['baseUrl', 'https://created.example.local/v1'], ['apiKey', 'local-fixture-only']]) await inputIn(evaluate, input, form(0), field, value);
  await evaluate('settingsFixture.channelFail=true'); await click(button(form(0), '创建渠道')); await wait(`!!${form(0)}.querySelector('[role=alert]')`);
  await evaluate('settingsFixture.channelFail=false;settingsFixture.refreshChannels()'); await sleep(150);
  ensure(await evaluate(`!!${form(0)}.querySelector('[role=alert]')&&${form(0)}.querySelector('[data-validation-field=name]').value==='尚未创建的草稿'`), 'an unrelated channel-list read cannot acknowledge a failed creation or discard its draft');

  await fresh(); await open(click, 'settings-a-0'); await inputIn(evaluate, input, form(0), 'name', '超出模型上限的草稿');
  await evaluate(`settingsFixture.channelFail=true;settingsFixture.error='旧保存诊断'`); await click(button(form(0), '保存修改'));
  await wait(`${form(0)}.textContent.includes('旧保存诊断')`);
  await evaluate(`settingsFixture.channelFail=false;settingsFixture.channelModels=['model-a','model-b',...Array.from({length:59},(_,i)=>'extra-'+i)]`);
  await click(button(form(0), '获取模型列表')); await wait(`${form(0)}.textContent.includes('目录共 61 个')`);
  await evaluate(`Array.from(${form(0)}.querySelectorAll('input[type=checkbox]')).forEach(e=>{if(!e.checked)e.click()})`);
  await wait(`${form(0)}.querySelector('button[type=submit]').disabled`); await click(button(form(0), '重新读取并保留编辑'));
  await wait(`!${form(0)}.textContent.includes('旧保存诊断')`);
  ensure(await evaluate(`${form(0)}.textContent.includes('已选择 61 个，请减少')&&document.activeElement===${form(0)}.querySelector('[data-validation-field=name]')`), 'reload recovery keeps over-limit validation and focuses an editable field when Save is disabled');
}
