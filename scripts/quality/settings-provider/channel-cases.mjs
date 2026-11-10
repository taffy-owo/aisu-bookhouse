const section = `document.querySelector('[aria-label="翻译渠道设置"]')`;
const form = `${section}.querySelector('form')`;
const button = text => `Array.from(${section}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
const editorButton = text => `Array.from(${form}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;

export async function probeChannelInteractions({ evaluate, wait, input, click, fresh, sleep, observations, shot }) {
  await fresh(); await click(button('编辑'));
  observations.push({ openingFocus: await evaluate(`document.activeElement?.dataset.validationField||document.activeElement?.tagName`) });
  await click(editorButton('取消'));
  observations[0].cancelFocus = await evaluate(`document.activeElement?.textContent.trim().slice(0,30)`);
  observations[0].cancelFocusedBody = await evaluate('document.activeElement===document.body');
  await click(button('编辑')); await evaluate('settingsFixture.channelHold=true');
  await evaluate(`(()=>{const b=${editorButton('获取模型列表')};b.click();b.click()})()`); await sleep(80);
  observations.push({ probeRequests: await evaluate('settingsFixture.channelRequests.length') });
  await evaluate('settingsFixture.releaseChannels()'); await wait(`${form}.textContent.includes('已获取最新模型列表')`);
  await fresh(320, 640, true); await click(button('编辑'));
  await evaluate(`settingsFixture.channelFail=true;settingsFixture.error='upstream_channel_diagnostic_'.repeat(60)`);
  await click(editorButton('获取模型列表')); await wait(`${form}.textContent.includes('upstream_channel_diagnostic_')`);
  observations.push({ probeError: await evaluate(`(()=>{const e=Array.from(${form}.querySelectorAll('span')).find(e=>e.textContent===settingsFixture.error),r=e.getBoundingClientRect();return {width:r.width,formWidth:${form}.clientWidth,scrollWidth:e.scrollWidth}})()`) });
  await input('[data-validation-field="name"]', '编辑中的名称'); await evaluate(`${form}.requestSubmit()`);
  await wait(`!!${form}.querySelector('[role=alert]')`);
  observations.at(-1).saveError = await evaluate(`(()=>{const e=${form}.querySelector('[role=alert]');return {width:e.clientWidth,scrollWidth:e.scrollWidth}})()`);
  await shot('channel-baseline-narrow-error');
  await fresh(); await click(button('编辑')); await evaluate('settingsFixture.channelHold=true;settingsFixture.channelIgnoreAbort=true');
  await click(editorButton('获取模型列表'));
  await evaluate(`settingsFixture.channelConfigs['settings-a'].splice(0,1);settingsFixture.refreshChannels()`);
  await wait(`${form}.textContent.includes('原渠道已移除')`);
  const aborted = await evaluate('settingsFixture.channelRequests[0].aborted');
  await evaluate('settingsFixture.releaseChannels()'); await sleep(100);
  observations.push({ removedChannelProbeAborted: aborted, staleProbeApplied: await evaluate(`${form}.textContent.includes('已获取最新模型列表')&&!!${form}.querySelector('[data-validation-field="model:model-new:model"]')`) });
}

export async function verifyChannelInteractions({ evaluate, wait, ensure, input, click, key, fresh, sleep, shot }) {
  const field = name => `[aria-label="翻译渠道设置"] form [data-validation-field="${name}"]`;
  const open = async () => { await click(button('编辑')); await wait(`!!${form}`); };
  const count = operation => `settingsFixture.channelRequests.filter(r=>r.operation==='${operation}').length`;
  const submit = () => evaluate(`${form}.requestSubmit()`);
  const longError = '渠道请求失败：' + 'upstream_channel_diagnostic_'.repeat(35) + '；输入内容仍会保留。';
  const fits = element => `(()=>{const e=${element};return e.clientWidth<=${form}.clientWidth&&e.scrollWidth<=e.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()`;
  const row = id => `Array.from(${section}?.querySelectorAll('[data-channel-id]')||[]).find(e=>e.dataset.channelId===${JSON.stringify(id)})`;
  for (const [width, height, touch, dark, font] of [
    [1536, 864, false, false, 16], [1536, 864, false, true, 16],
    [768, 1024, true, true, 16], [320, 640, true, false, 16],
    [390, 844, true, true, 32], [844, 390, true, false, 16],
  ]) {
    const label = `${width}x${height} ${dark ? 'dark' : 'light'} ${font}px`;
    await fresh(width, height, touch, dark, font);
    await evaluate(`${button('添加渠道')}.scrollIntoView({block:'center'});${button('添加渠道')}.focus()`); await key('Enter'); await wait(`!!${form}`);
    ensure(await evaluate(`document.activeElement?.dataset.validationField==='name'`), label + ' keyboard creation focuses the name field');
    await submit(); await wait(`${form}.querySelector('[data-validation-field=name]').getAttribute('aria-invalid')==='true'`);
    ensure(await evaluate(`document.activeElement?.dataset.validationField==='name'&&${count('create')}===0`), label + ' invalid creation focuses the missing field without a request');
    await click(editorButton('取消')); await wait(`!${form}`);
    await wait(`document.activeElement===${button('添加渠道')}`);
    ensure(await evaluate(`document.activeElement===${button('添加渠道')}`), label + ' cancelling creation returns focus to Add');
    await open(); ensure(await evaluate(`document.activeElement?.dataset.validationField==='name'`), label + ' editing focuses the first field');
    await evaluate(`settingsFixture.channelHold=true;settingsFixture.channelFail=true;settingsFixture.error=${JSON.stringify(longError)}`);
    await evaluate(`(()=>{const b=${editorButton('获取模型列表')};b.click();b.click()})()`); await wait(count('probe') + '>0');
    ensure(await evaluate(count('probe')) === 1, label + ' duplicate model requests send one probe');
    await evaluate('settingsFixture.releaseChannels()'); await wait(`!!${form}.querySelector('[role=alert]')`);
    ensure(await evaluate(`${form}.querySelector('[role=alert]').textContent===${JSON.stringify(longError)}`), label + ' probe errors expose the full diagnostic');
    ensure(await evaluate(fits(`${form}.querySelector('[role=alert]')`)), label + ' probe errors wrap within the editor');
    await input(field('name'), '本地修改的渠道');
    await evaluate('settingsFixture.channelHold=true'); await evaluate(`${form}.requestSubmit();${form}.requestSubmit()`); await wait(count('save') + '>0');
    ensure(await evaluate(count('save')) === 1, label + ' repeated submissions save once');
    ensure(await evaluate(`${form}.getAttribute('aria-busy')==='true'&&${form}.querySelector('fieldset').disabled`), label + ' pending save disables the editor and exposes busy state');
    await evaluate('settingsFixture.releaseChannels()'); await wait(`${form}.getAttribute('aria-busy')==='false'&&!!${form}.querySelector('[role=alert]')`);
    ensure(await evaluate(`document.querySelector(${JSON.stringify(field('name'))}).value==='本地修改的渠道'`), label + ' failed save preserves the draft');
    ensure(await evaluate(fits(`${form}.querySelector('[role=alert]')`)), label + ' save errors remain fully readable');
    if (width === 320 || width === 1536 && dark) { await evaluate(`${form}.querySelector('[role=alert]').scrollIntoView({block:'center'})`); await shot(label.replaceAll(' ', '-') + '-channel-error'); }
    await evaluate('settingsFixture.channelFail=false'); await submit(); await wait(`!${form}`);
    await wait(`document.activeElement===${row('settings-a-0')}.querySelector('[data-channel-action=edit]')`);
    ensure(await evaluate(`document.activeElement===${row('settings-a-0')}.querySelector('[data-channel-action=edit]')`), label + ' successful save returns focus to the updated channel');
    ensure(await evaluate(`settingsFixture.channelConfigs['settings-a'][0].name==='本地修改的渠道'&&${count('save')}===2`), label + ' retry commits the preserved draft');
    await click(`${row('settings-a-0')}.querySelector('[data-channel-action=edit]')`); await click(editorButton('取消'));
    await wait(`document.activeElement===${row('settings-a-0')}.querySelector('[data-channel-action=edit]')`);
    ensure(await evaluate(`document.activeElement===${row('settings-a-0')}.querySelector('[data-channel-action=edit]')`), label + ' cancelling an edit returns to its own channel');
  }

  await fresh(); await open(); await evaluate('settingsFixture.channelHold=true;settingsFixture.channelIgnoreAbort=true');
  await click(editorButton('获取模型列表')); await input(field('baseUrl'), 'https://new-channel.example.local/v1');
  ensure(await evaluate('settingsFixture.channelRequests[0].aborted'), 'editing credentials cancels the active channel probe');
  await evaluate('settingsFixture.releaseChannels()'); await sleep(100);
  ensure(await evaluate(`!${form}.textContent.includes('已获取最新模型列表')&&!${form}.querySelector('[data-validation-field="model:model-new:model"]')`), 'late model results cannot update a changed channel address');
  await input(field('baseUrl'), 'https://channel.example.local/v1'); await click(editorButton('获取模型列表')); await wait(`${form}.textContent.includes('已获取最新模型列表')`);
  ensure(await evaluate(count('probe')) === 2, 'credential invalidation releases the probe lock');

  await fresh(); await open(); await input(field('name'), '草稿名称');
  await evaluate(`${form}.querySelector('details').open=true`); await input(field('model:model-a:chunkCharacters'), '6200');
  await evaluate('settingsFixture.channelHold=true;settingsFixture.channelIgnoreAbort=true'); await click(editorButton('获取模型列表'));
  await evaluate(`settingsFixture.updateChannel({name:'服务端名称',base_url:'https://updated-channel.example.local/v1',models:[{...settingsFixture.channelConfigs['settings-a'][0].models[0],enabled:false,chunk_characters:5000}]});settingsFixture.refreshChannels()`);
  await wait(`${form}.textContent.includes('渠道资料已同步')`);
  ensure(await evaluate(`document.querySelector(${JSON.stringify(field('name'))}).value==='草稿名称'&&document.querySelector(${JSON.stringify(field('baseUrl'))}).value==='https://updated-channel.example.local/v1'`), 'background updates preserve edited fields and refresh pristine fields');
  ensure(await evaluate(`document.querySelector(${JSON.stringify(field('model:model-a:chunkCharacters'))}).value==='6200'&&!document.querySelector(${JSON.stringify(field('model:model-a:model'))}).checked`), 'model reconciliation preserves local tuning and applies the server selection');
  ensure(await evaluate('settingsFixture.channelRequests[0].aborted'), 'background channel updates cancel the obsolete probe');
  await evaluate('settingsFixture.releaseChannels()'); await sleep(80); await click(editorButton('获取模型列表')); await wait(`${form}.textContent.includes('已获取最新模型列表')`);
  ensure(await evaluate(count('probe')) === 2, 'a refreshed channel can fetch models again');
  await submit(); await wait(`!${form}`);
  ensure(await evaluate(`settingsFixture.channelRequests.at(-1).body.expected_updated_at==='revision-1'&&settingsFixture.channelConfigs['settings-a'][0].models[0].chunk_characters===6200`), 'saving uses the latest revision while retaining local model tuning');

  await fresh(); await open(); await input(field('name'), '移除后保留的草稿');
  await evaluate('settingsFixture.channelHold=true;settingsFixture.channelIgnoreAbort=true'); await click(editorButton('获取模型列表'));
  await evaluate(`settingsFixture.channelConfigs['settings-a'].splice(0,1);settingsFixture.refreshChannels()`); await wait(`${form}.textContent.includes('原渠道已移除')`);
  ensure(await evaluate(`document.querySelector(${JSON.stringify(field('name'))}).value==='移除后保留的草稿'`), 'a remotely removed channel keeps its editor draft');
  await evaluate('settingsFixture.releaseChannels()'); await sleep(80);
  ensure(await evaluate(`!${form}.textContent.includes('已获取最新模型列表')&&!${form}.querySelector('[data-validation-field="model:model-new:model"]')`), 'a removed channel ignores its late probe result');
  ensure(await evaluate(`${editorButton('创建渠道')}.disabled`), 'recreating a removed channel requires a fresh key');
  await input(field('apiKey'), 'local-fixture-key'); await submit(); await wait(`!${form}`);
  ensure(await evaluate(`settingsFixture.channelConfigs['settings-a'].some(c=>c.name==='移除后保留的草稿')&&document.activeElement?.dataset.channelAction==='edit'`), 'a removed draft can be recreated and focuses its new channel');

  for (const operation of ['probe', 'save']) for (const fail of [false, true]) {
    await fresh(); await open(); await evaluate(`settingsFixture.channelHold=true;settingsFixture.channelIgnoreAbort=true;settingsFixture.channelFail=${fail}`);
    if (operation === 'probe') await click(editorButton('获取模型列表')); else { await input(field('name'), '旧账号的草稿'); await submit(); }
    await wait(count(operation) + '===1'); await evaluate('settingsFixture.switchAccount()');
    await wait(`!!${row('settings-b-0')}`);
    ensure(await evaluate('settingsFixture.channelRequests[0].aborted'), operation + ' account switch cancels the old request');
    await evaluate('settingsFixture.releaseChannels()'); await sleep(100);
    ensure(await evaluate(`!${form}&&!!${row('settings-b-0')}&&!${section}.querySelector('[role=alert]')`), operation + ' late ' + (fail ? 'failure' : 'success') + ' cannot alter the new account');
  }
  await fresh(); await open(); await evaluate('settingsFixture.channelHold=true;settingsFixture.channelIgnoreAbort=true');
  await click(editorButton('获取模型列表')); await evaluate('settingsFixture.navigate("/away")'); await wait('!!document.querySelector("#reopen")');
  ensure(await evaluate('settingsFixture.channelRequests[0].aborted'), 'leaving settings aborts channel probes');
  await evaluate('settingsFixture.releaseChannels()'); await click('document.querySelector("#reopen")'); await wait(`!!${section}`);
  await evaluate(`document.querySelectorAll('.settings-disclosure')[1].open=true`); await open(); await click(editorButton('获取模型列表'));
  await wait(`${form}.textContent.includes('已获取最新模型列表')`); ensure(await evaluate(count('probe')) === 2, 'returning to settings permits a fresh channel probe');

  for (const action of ['toggle', 'delete']) for (const fail of [false, true]) {
    await fresh(320, 640, true); const target = `${row('settings-a-0')}.querySelector('[data-channel-action=${action}]')`;
    await evaluate(`settingsFixture.channelHold=true;settingsFixture.channelFail=${fail};settingsFixture.error=${JSON.stringify(longError)};(()=>{const b=${target};b.focus();b.click();b.click()})()`);
    await wait('settingsFixture.channelRequests.length===1'); ensure(await evaluate('settingsFixture.channelRequests.length') === 1, action + ' duplicate activation sends one mutation');
    await evaluate('settingsFixture.releaseChannels()'); await sleep(120);
    if (fail) {
      ensure(await evaluate(`!!${row('settings-a-0')}.querySelector('[role=alert]')&&document.activeElement===${target}`), action + ' failure restores its action focus');
      ensure(await evaluate(`(()=>{const e=${row('settings-a-0')}.querySelector('[role=alert]');return e.scrollWidth<=e.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()`), action + ' row errors wrap within the screen');
    } else if (action === 'toggle') ensure(await evaluate(`!settingsFixture.channelConfigs['settings-a'][0].enabled&&document.activeElement===${target}`), 'toggling keeps focus on the resulting action');
    else ensure(await evaluate(`!${row('settings-a-0')}&&document.activeElement===${row('settings-a-1')}.querySelector('[data-channel-action=edit]')`), 'deleting a channel focuses the remaining neighbour');
  }
  await fresh(); await evaluate('settingsFixture.confirmResult=false'); await click(`${row('settings-a-0')}.querySelector('[data-channel-action=delete]')`);
  ensure(await evaluate('settingsFixture.channelRequests.length===0'), 'cancelling deletion sends no request');
  await evaluate(`settingsFixture.channelConfigs['settings-a'].splice(1,1);settingsFixture.refreshChannels()`); await wait(`!${row('settings-a-1')}`);
  await evaluate('settingsFixture.confirmResult=true'); await click(`${row('settings-a-0')}.querySelector('[data-channel-action=delete]')`); await wait(`!${row('settings-a-0')}`);
  await wait(`document.activeElement===${button('添加渠道')}`);
  ensure(await evaluate(`document.activeElement===${button('添加渠道')}`), 'deleting the last channel returns focus to Add');

  await fresh(320, 640, true); await click(button('添加渠道'));
  for (const [name, value] of [['name', '新建的翻译渠道'], ['baseUrl', 'https://created.example.local/v1'], ['apiKey', 'fixture-key']]) await input(field(name), value);
  await submit(); await wait(`!${form}`); await wait(`document.activeElement?.dataset.channelAction==='edit'`);
  const createdId = await evaluate(`settingsFixture.channelConfigs['settings-a'].at(-1).id`);
  ensure(await evaluate(`document.activeElement===${row(createdId)}.querySelector('[data-channel-action=edit]')`), 'creating a channel focuses its new row for model setup');
  await click(`${row(createdId)}.querySelector('[data-channel-action=edit]')`); await click(editorButton('获取模型列表')); await wait(`${form}.textContent.includes('已获取最新模型列表')`);
  await click(`${form}.querySelector('[data-validation-field="model:model-new:model"]')`); await submit(); await wait(`!${form}`);
  ensure(await evaluate(`settingsFixture.channelConfigs['settings-a'].at(-1).models.length===1&&settingsFixture.channelConfigs['settings-a'].at(-1).models[0].model==='model-new'`), 'new channels save selected models without adding unchecked catalog entries');

  for (const operation of ['probe', 'save', 'toggle']) {
    await fresh(); if (operation !== 'toggle') await open();
    await evaluate('settingsFixture.channelHold=true');
    if (operation === 'probe') await click(editorButton('获取模型列表'));
    else if (operation === 'save') { await input(field('name'), '保持其他输入焦点'); await submit(); }
    else await click(`${row('settings-a-0')}.querySelector('[data-channel-action=toggle]')`);
    await evaluate(`document.querySelector('[aria-label="搜索书名、作者"]').focus();settingsFixture.releaseChannels()`); await sleep(160);
    ensure(await evaluate(`document.activeElement===document.querySelector('[aria-label="搜索书名、作者"]')`), operation + ' completion preserves focus in another field');
  }
  await fresh(320, 640, true); await open(); await input(field('name'), '同步失败时的草稿');
  await evaluate(`settingsFixture.channelFailReads=true;settingsFixture.error=${JSON.stringify(longError)};settingsFixture.refreshChannels()`);
  await wait(`${section}.textContent.includes('重试同步渠道')`);
  ensure(await evaluate(`document.querySelector(${JSON.stringify(field('name'))}).value==='同步失败时的草稿'`), 'failed channel refresh preserves the open draft');
  ensure(await evaluate(`(()=>{const e=Array.from(${section}.querySelectorAll('[role=alert]')).find(e=>e.textContent.includes('重试同步渠道')).querySelector('span');return e.clientWidth<=e.parentElement.clientWidth&&e.scrollWidth<=e.clientWidth+1})()`), 'channel refresh errors fit narrow screens');
  await evaluate('settingsFixture.channelFailReads=false'); await click(button('重试同步渠道')); await wait(`!${section}.textContent.includes('重试同步渠道')`);
  ensure(await evaluate(`document.querySelector(${JSON.stringify(field('name'))}).value==='同步失败时的草稿'`), 'refresh retry keeps local edits');
  await fresh(); await open(); await evaluate('settingsFixture.channelHold=true'); await click(editorButton('获取模型列表'));
  await evaluate('settingsFixture.releaseChannels()'); await wait(`${form}.textContent.includes('已获取最新模型列表')`);
  await wait(`document.activeElement===${editorButton('获取模型列表')}`);
  ensure(await evaluate(`document.activeElement===${editorButton('获取模型列表')}`), 'completed probes restore focus after the busy button is enabled');
}
