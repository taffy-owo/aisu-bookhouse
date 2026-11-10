const section = `document.querySelector('[aria-label="翻译渠道设置"]')`;
const row = id => `Array.from(${section}?.querySelectorAll('[data-channel-id]')||[]).find(e=>e.dataset.channelId===${JSON.stringify(id)})`;
const action = (id, name) => `${row(id)}.querySelector('[data-channel-action=${name}]')`;
const button = text => `Array.from(${section}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;

export async function probeChannelBoundaries({ fresh, evaluate, click, wait, observations, shot }) {
  await fresh();
  await evaluate(`settingsFixture.updateChannel({name:'服务端更新的渠道'})`);
  await click(action('settings-a-0', 'toggle'));
  await wait(`!!${row('settings-a-0')}.querySelector('[role=alert]')`);
  const conflict = await evaluate(`${row('settings-a-0')}.querySelector('[role=alert]').textContent`);
  await click(button('重新读取渠道'));
  await wait(`${row('settings-a-0')}.textContent.includes('服务端更新的渠道')`);
  observations.push({ conflict, staleErrorAfterNewRevision: await evaluate(`!!${row('settings-a-0')}.querySelector('[role=alert]')`) });
  await shot('channel-conflict-baseline');

  await fresh();
  await evaluate(`settingsFixture.channelFail=true;settingsFixture.error='删除请求失败，请重试。'`);
  await click(action('settings-a-0', 'delete'));
  await wait(`!!${row('settings-a-0')}.querySelector('[role=alert]')`);
  await evaluate('settingsFixture.channelFail=false');
  const reads = await evaluate('settingsFixture.channelReads.length');
  await click(button('重新读取渠道'));
  await wait(`settingsFixture.channelReads.length>${reads}`);
  observations.push({ staleErrorAfterSameRevision: await evaluate(`!!${row('settings-a-0')}.querySelector('[role=alert]')`) });
}

export async function verifyChannelBoundaries({ fresh, evaluate, click, wait, ensure, input, sleep, shot }) {
  const first = row('settings-a-0');
  const firstForm = `${section}.querySelector('form')`;
  const editorButton = (form, text) => `Array.from(${form}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const inputIn = async (form, field, value) => input(await evaluate(`'#'+CSS.escape(${form}.querySelector('[data-validation-field="${field}"]').id)`), value);
  const conflict = async () => {
    await evaluate(`settingsFixture.updateChannel({name:'服务端更新的渠道'})`);
    await click(action('settings-a-0', 'toggle'));
    await wait(`!!${first}.querySelector('[role=alert]')`);
  };

  for (const [width, height, touch, dark] of [[1536, 864, false, true], [768, 1024, true, true], [320, 640, true, false]]) {
    const label = width + ' conflict recovery';
    await fresh(width, height, touch, dark); await conflict();
    ensure(await evaluate(`${first}.textContent.includes('渠道已被其他操作更新')`), label + ' reports a real revision conflict');
    await evaluate('settingsFixture.channelFailReads=true'); await click(button('重新读取渠道'));
    await wait(`${section}.textContent.includes('重试同步渠道')`);
    ensure(await evaluate(`${first}.textContent.includes('渠道已被其他操作更新')`), label + ' failed reads retain the unresolved action error');
    await evaluate('settingsFixture.channelFailReads=false'); await click(button('重新读取渠道'));
    await wait(`${first}.textContent.includes('服务端更新的渠道')&&!${first}.querySelector('[role=alert]')`);
    await wait(`document.activeElement===${action('settings-a-0', 'toggle')}`);
    ensure(await evaluate(`!${section}.querySelector('[role=alert]')`), label + ' a confirmed fresh read clears obsolete errors');
    ensure(await evaluate(`document.activeElement===${action('settings-a-0', 'toggle')}`), label + ' removing the retry control restores the failed action focus');
    await click(action('settings-a-0', 'toggle'));
    await wait(`!settingsFixture.channelConfigs['settings-a'][0].enabled`);
    ensure(await evaluate(`!${first}.querySelector('[role=alert]')`), label + ' the next action uses the refreshed revision');
    if (width === 320) await shot('channel-conflict-recovered-narrow');
  }

  await fresh(); await evaluate(`settingsFixture.channelFail=true;settingsFixture.error='删除请求失败，请重试。'`);
  await click(action('settings-a-0', 'delete')); await wait(`!!${first}.querySelector('[role=alert]')`);
  await evaluate('settingsFixture.channelFail=false'); await click(button('重新读取渠道'));
  await wait(`!${first}.querySelector('[role=alert]')`);
  await wait(`document.activeElement===${action('settings-a-0', 'delete')}`);
  ensure(await evaluate(`!!${first}&&document.activeElement===${action('settings-a-0', 'delete')}`), 'successful same-revision reads acknowledge old delete failures and restore focus');

  await fresh();
  await evaluate(`settingsFixture.channelHoldReads=true;settingsFixture.refreshChannels()`);
  await wait('settingsFixture.channelPendingReads.length===1');
  await evaluate(`settingsFixture.channelFail=true;settingsFixture.error='读取开始后才发生的停用错误'`);
  await click(action('settings-a-0', 'toggle')); await wait(`!!${first}.querySelector('[role=alert]')`);
  await evaluate('settingsFixture.releaseChannelReads()'); await sleep(120);
  ensure(await evaluate(`${first}.textContent.includes('读取开始后才发生的停用错误')`), 'an earlier in-flight snapshot cannot dismiss a newer action failure');
  await evaluate('settingsFixture.refreshChannels()'); await wait(`!${first}.querySelector('[role=alert]')`);
  ensure(await evaluate(`!${first}.querySelector('[role=alert]')`), 'a later background read clears an acknowledged action error');

  await fresh(); await conflict();
  await evaluate('settingsFixture.channelHoldReads=true'); await click(button('重新读取渠道'));
  await evaluate(`settingsFixture.channelFail=true;settingsFixture.error='第二次操作的删除错误'`);
  await click(action('settings-a-0', 'delete')); await wait(`${first}.textContent.includes('第二次操作的删除错误')`);
  await evaluate('settingsFixture.releaseChannelReads()'); await sleep(120);
  ensure(await evaluate(`${first}.textContent.includes('第二次操作的删除错误')`), 'a reload for the first failure cannot erase a later failure');
  await evaluate('settingsFixture.refreshChannels()'); await wait(`!${first}.querySelector('[role=alert]')`);

  await fresh(); await conflict();
  await evaluate('settingsFixture.channelHoldReads=true;settingsFixture.channelIgnoreAbort=true');
  await click(button('重新读取渠道'));
  await evaluate(`settingsFixture.channelFailReads=true;settingsFixture.error='后一次读取失败'`);
  await click(button('重新读取渠道'));
  ensure(await evaluate('settingsFixture.channelReads.at(-2).aborted'), 'repeated reloads cancel the preceding read');
  await evaluate('settingsFixture.releaseChannelReads()'); await wait(`${section}.textContent.includes('后一次读取失败')`);
  ensure(await evaluate(`!!${first}.querySelector('[role=alert]')`), 'a late cancelled success cannot clear an error after the current read fails');
  await evaluate('settingsFixture.channelFailReads=false'); await click(button('重试同步渠道'));
  await wait(`!${section}.querySelector('[role=alert]')`);
  ensure(await evaluate(`!${first}.querySelector('[role=alert]')`), 'retrying a failed global sync also acknowledges old row errors');

  await fresh(); await conflict();
  await evaluate('settingsFixture.channelHoldReads=true'); await click(button('重新读取渠道'));
  await evaluate(`document.querySelector('[aria-label="搜索书名、作者"]').focus();settingsFixture.releaseChannelReads()`);
  await wait(`!${first}.querySelector('[role=alert]')`);
  ensure(await evaluate(`document.activeElement===document.querySelector('[aria-label="搜索书名、作者"]')`), 'background recovery does not steal focus from another field');

  for (const [width, height, touch, dark] of [[1536, 864, false, true], [320, 640, true, false]]) {
    const label = width + ' model limits';
    await fresh(width, height, touch, dark); await click(action('settings-a-0', 'edit'));
    await evaluate(`settingsFixture.channelModels=['model-a','model-b',...Array.from({length:298},(_,i)=>'catalog-'+i)]`);
    await click(editorButton(firstForm, '获取模型列表')); await wait(`${firstForm}.textContent.includes('目录共 300 个')`);
    ensure(await evaluate(`${firstForm}.querySelectorAll('input[type=checkbox]').length===300`), label + ' shows the entire 300-model catalog');
    await evaluate(`(()=>{const e=${firstForm};e.querySelectorAll('details')[1].open=true;Array.from(e.querySelectorAll('input[type=checkbox]')).slice(2,61).forEach(input=>input.click())})()`);
    await inputIn(firstForm, 'model:model-b:chunkCharacters', '6200');
    await wait(`${firstForm}.textContent.includes('已选择 60 个模型')`);
    ensure(await evaluate(`!${firstForm}.querySelector('button[type=submit]').disabled`), label + ' exactly 60 enabled models can be saved');
    await evaluate(`${firstForm}.querySelectorAll('input[type=checkbox]')[61].click()`);
    await wait(`${firstForm}.textContent.includes('已选择 61 个，请减少')`);
    ensure(await evaluate(`${firstForm}.querySelector('button[type=submit]').disabled`), label + ' the 61st selection clearly blocks saving');
    await evaluate(`${firstForm}.requestSubmit()`); await sleep(100);
    ensure(await evaluate(`!settingsFixture.channelRequests.some(r=>r.operation==='save')`), label + ' over-limit submissions send no write');
    await evaluate(`${firstForm}.querySelectorAll('input[type=checkbox]')[61].click()`);
    await wait(`!${firstForm}.querySelector('button[type=submit]').disabled`);
    await click(editorButton(firstForm, '保存修改')); await wait(`!${firstForm}`);
    ensure(await evaluate(`(()=>{const m=settingsFixture.channelConfigs['settings-a'][0].models;return m.length===61&&m.filter(e=>e.enabled).length===60&&m.find(e=>e.model==='model-b').chunk_characters===6200&&!m.find(e=>e.model==='model-b').enabled})()`), label + ' saving preserves disabled configured tuning without saving unchecked catalog entries');
  }

  await fresh(); await click(action('settings-a-0', 'edit')); await click(action('settings-a-1', 'edit'));
  const formAt = index => `${section}.querySelectorAll('form')[${index}]`;
  await inputIn(formAt(0), 'name', '第一个渠道草稿'); await inputIn(formAt(1), 'name', '第二个渠道草稿');
  await evaluate('settingsFixture.channelHold=true;settingsFixture.channelIgnoreAbort=true');
  await click(editorButton(formAt(0), '获取模型列表')); await click(editorButton(formAt(1), '获取模型列表'));
  ensure(await evaluate(`settingsFixture.channelRequests.filter(r=>r.operation==='probe').length===2&&${section}.querySelectorAll('form').length===2`), 'each open editor owns an independent model probe');
  await click(editorButton(formAt(0), '取消'));
  ensure(await evaluate('settingsFixture.channelRequests[0].aborted&&!settingsFixture.channelRequests[1].aborted'), 'cancelling one editor leaves the other probe running');
  await evaluate('settingsFixture.releaseChannels()'); await wait(`${firstForm}.textContent.includes('已获取最新模型列表')`);
  ensure(await evaluate(`${firstForm}.querySelector('[data-validation-field=name]').value==='第二个渠道草稿'&&!!${first}`), 'late cancelled results leave the remaining editor and its draft intact');
  await evaluate(`settingsFixture.updateChannel({name:'第一个渠道远端新名称'});settingsFixture.refreshChannels()`);
  await wait(`${first}.textContent.includes('第一个渠道远端新名称')`);
  ensure(await evaluate(`${firstForm}.querySelector('[data-validation-field=name]').value==='第二个渠道草稿'`), 'refreshing one channel does not discard another editor draft');
  await click(editorButton(firstForm, '保存修改')); await wait(`!${firstForm}`);
  ensure(await evaluate(`settingsFixture.channelConfigs['settings-a'][0].name==='第一个渠道远端新名称'&&settingsFixture.channelConfigs['settings-a'][1].name==='第二个渠道草稿'`), 'saving the remaining editor only updates its own channel');
}
