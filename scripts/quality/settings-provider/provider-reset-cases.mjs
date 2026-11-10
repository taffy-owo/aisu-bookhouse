const form = `document.querySelector('form[aria-label="第三方 AI 设置"]')`;
const button = text => `Array.from(${form}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;

export async function probeProviderReset({ fresh, evaluate, click, wait, observations }) {
  await fresh(); await evaluate('settingsFixture.confirmResult=false'); await click(button('移除配置'));
  const confirmation = await evaluate('settingsFixture.confirmations.at(-1)');
  await evaluate('settingsFixture.confirmResult=true;settingsFixture.hold=true'); await click(button('移除配置'));
  await wait(`settingsFixture.requests.some(r=>r.operation==='remove')`);
  await evaluate('settingsFixture.release()'); await wait(`!${button('移除配置')}`);
  observations.push({ confirmation, focusAfterRemove: await evaluate('document.activeElement?.tagName'), removedStatus: await evaluate(`${form}.querySelector('[role=status]')?.textContent||''`), hasUnsavedChanges: await evaluate(`${form}.textContent.includes('有未保存的修改')`) });
}

export async function verifyProviderReset({ fresh, evaluate, click, wait, ensure, input, sleep, command, shot }) {
  const prompt = 'textarea[aria-label="翻译预设"]';
  const count = operation => `settingsFixture.requests.filter(r=>r.operation==='${operation}').length`;
  const channelRow = id => `Array.from(document.querySelectorAll('[data-channel-id]')).find(e=>e.dataset.channelId==='${id}')`;
  const prepareDefault = async () => {
    await evaluate(`settingsFixture.channelConfigs['settings-a'][0].is_provider_default=true;settingsFixture.settings['settings-a'].translation_concurrency=4;settingsFixture.refresh();settingsFixture.refreshChannels()`);
    await wait(`${form}.querySelector('[aria-label="精翻并发请求数"] [aria-pressed=true]').textContent.trim()==='4'`);
  };
  for (const [width, height, touch, dark, font] of [[1536, 864, false, false, 16], [1536, 864, false, true, 16], [768, 1024, true, true, 16], [320, 640, true, false, 16], [390, 844, true, true, 32], [844, 390, true, false, 16]]) {
    const label = `${width} ${dark?'dark':'light'} ${font}px removal`;
    await fresh(width, height, touch, dark, font); await prepareDefault();
    ensure(await evaluate(`(()=>{const f=${form},bounds=f.getBoundingClientRect();return Array.from(f.firstElementChild.querySelectorAll('button')).every(e=>{const r=e.getBoundingClientRect();return r.height<=${font}*3&&r.left>=bounds.left&&r.right<=bounds.right})})()`), label + ' action labels stay horizontal and whole buttons wrap inside the form');
    await evaluate('settingsFixture.confirmResult=false'); await click(button('移除配置'));
    ensure(await evaluate(`settingsFixture.confirmations.at(-1).includes('翻译预设会清空')&&settingsFixture.confirmations.at(-1).includes('精翻并发恢复为 2')&&settingsFixture.confirmations.at(-1).includes('其他手动添加的渠道会保留')`), label + ' confirmation explains preset deletion, concurrency reset and retained manual channels');
    ensure(await evaluate(`${count('remove')}===0&&settingsFixture.settings['settings-a'].translation_prompt==='原有预设'`), label + ' cancellation leaves configuration and preset untouched');
    if (font === 32) await shot('provider-header-largefont-fixed');
    await evaluate(`settingsFixture.confirmResult=true;settingsFixture.hold=true;(()=>{const b=${button('移除配置')};b.focus();b.click();b.click()})()`);
    await wait(`${count('remove')}===1`);
    ensure(await evaluate(`${count('remove')}===1&&${form}.getAttribute('aria-busy')==='true'`), label + ' repeated activation sends one removal and exposes busy state');
    await evaluate('settingsFixture.release()'); await wait(`!${button('移除配置')}&&!!${form}.querySelector('[role=status]')`);
    await wait(`document.activeElement===${form}`);
    ensure(await evaluate(`${form}.querySelector('[role=status]').textContent==='已移除已保存的配置。'`), label + ' removal has an explicit announced result');
    ensure(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value===''&&document.querySelector('#translation-provider-base-url').value===''&&document.querySelector('#audiobook-provider-base-url').value===''&&${form}.querySelector('[aria-label="精翻并发请求数"] [aria-pressed=true]').textContent.trim()==='2'`), label + ' displayed fields match the cleared server configuration');
    ensure(await evaluate(`!${form}.textContent.includes('有未保存的修改')&&${button('已移除')}.disabled`), label + ' confirmed removal does not invent an unsaved draft');
    ensure(await evaluate(`document.activeElement===${form}&&document.activeElement.tagName!=='INPUT'`), label + ' keyboard continuity stays in settings without opening a touch keyboard');
    await wait(`!${channelRow('settings-a-0')}&&!!${channelRow('settings-a-1')}`);
    ensure(await evaluate(`settingsFixture.channelConfigs['settings-a'].length===1&&settingsFixture.channelConfigs['settings-a'][0].id==='settings-a-1'`), label + ' only the associated default channel is removed');
    ensure(await evaluate(`(()=>{const e=${form}.querySelector('[role=status]');return e.scrollWidth<=e.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()`), label + ' result text remains readable inside the viewport');
    if (width === 320) await shot('provider-removed-narrow');
  }

  for (const operation of ['remove', 'save']) for (const fail of [false, true]) {
    await fresh(320, 640, true, true);
    if (operation === 'save') await input(prompt, '本次提交的预设');
    await evaluate(`settingsFixture.hold=true;settingsFixture.fail=${fail};settingsFixture.error='完整的失败说明：'+'provider_operation_failed_'.repeat(30)`);
    await click(button(operation === 'remove' ? '移除配置' : '保存设置'));
    await wait(`${count(operation)}===1`); await evaluate('settingsFixture.release()');
    await wait(`${form}.getAttribute('aria-busy')==='false'`);
    const target = fail ? button(operation === 'remove' ? '移除配置' : '保存设置') : form;
    await wait(`document.activeElement===${target}`);
    ensure(await evaluate(`document.activeElement===${target}`), operation + '/' + fail + ' returns focus only after the replacement controls are ready');
    if (fail) {
      ensure(await evaluate(`!!${form}.querySelector('[role=alert]')&&settingsFixture.settings['settings-a'].api_key_configured&&document.querySelector(${JSON.stringify(prompt)}).value===${JSON.stringify(operation === 'save' ? '本次提交的预设' : '原有预设')}`), operation + ' failure retains the saved credentials and current preset');
      ensure(await evaluate(`(()=>{const e=${form}.querySelector('[role=alert]');return e.scrollWidth<=e.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()`), operation + ' complete diagnostics wrap on a narrow screen');
    } else ensure(await evaluate(`!!${form}.querySelector('[role=status]')`), operation + ' success is announced independently of button state');
  }

  await fresh(); await evaluate('settingsFixture.hold=true'); await click(button('移除配置'));
  for (const [selector, value] of [['#translation-provider-base-url','https://replacement.example.com/v1'], ['#translation-provider-api-key','fixture-replacement-key'], ['#translation-model','replacement-model'], [prompt,'移除期间新输入的预设']]) await input(selector, value);
  await evaluate(`document.querySelector(${JSON.stringify(prompt)}).focus();settingsFixture.release()`);
  await wait(`!!${form}.querySelector('[role=status]')`);
  ensure(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value==='移除期间新输入的预设'&&document.querySelector('#translation-provider-api-key').value==='fixture-replacement-key'&&document.querySelector('#translation-model').value==='replacement-model'`), 'removal preserves replacement credentials and preset entered while it was pending');
  ensure(await evaluate(`${form}.querySelector('[role=status]').textContent.includes('新输入的修改尚未保存')&&!${button('保存设置')}.disabled&&document.activeElement===document.querySelector(${JSON.stringify(prompt)})`), 'removal distinguishes unsaved replacements and preserves their input focus');
  await click(button('保存设置')); await wait(`${form}.textContent.includes('本次设置已保存')`);
  ensure(await evaluate(`settingsFixture.settings['settings-a'].api_key_configured&&settingsFixture.settings['settings-a'].translation_prompt==='移除期间新输入的预设'`), 'the preserved replacement can be saved as a new configuration');

  await fresh(); await input(prompt, '本次提交的预设'); await evaluate('settingsFixture.hold=true'); await click(button('保存设置'));
  await input(prompt, '提交之后继续输入的预设'); await evaluate(`document.querySelector(${JSON.stringify(prompt)}).focus();settingsFixture.release()`);
  await wait(`${form}.textContent.includes('本次设置已保存')`);
  ensure(await evaluate(`settingsFixture.settings['settings-a'].translation_prompt==='本次提交的预设'&&document.querySelector(${JSON.stringify(prompt)}).value==='提交之后继续输入的预设'&&${form}.querySelector('[role=status]').textContent.includes('新输入的修改尚未保存')`), 'save completion acknowledges its snapshot without claiming later preset edits were saved');

  await fresh(); await input(prompt, ''); await evaluate(`document.querySelector(${JSON.stringify(prompt)}).focus()`);
  const pasted = '称呼保持一致。\n对话自然。'.repeat(550);
  await command('Input.insertText', { text: pasted });
  const expected = pasted.slice(0, 6000).trim();
  ensure(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value.length===6000&&document.querySelector(${JSON.stringify(prompt)}).nextElementSibling.textContent.includes('6,000 / 6,000')`), 'real long-preset paste respects the visible 6000-character limit');
  await click(button('保存设置')); await wait(`${form}.textContent.includes('本次设置已保存')`);
  ensure(await evaluate(`settingsFixture.settings['settings-a'].translation_prompt===${JSON.stringify(expected)}&&settingsFixture.requests.at(-1).fields.join(',')==='translation_prompt'`), 'preset-only saving preserves internal line breaks and sends no provider credential changes');
  await input(prompt, '   '); await click(button('保存设置')); await wait(`settingsFixture.settings['settings-a'].translation_prompt===''`);
  ensure(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value===''&&settingsFixture.settings['settings-a'].api_key_configured&&settingsFixture.settings['settings-a'].audiobook_api_key_configured`), 'clearing only the preset retains both provider configurations');

  await fresh(); await evaluate('settingsFixture.hold=true;settingsFixture.ignoreAbort=true');
  for (const kind of ['translation', 'audiobook']) await click(`Array.from(document.querySelector('#${kind}-model').closest('section').querySelectorAll('button')).find(e=>e.textContent.trim()==='获取模型')`);
  await click(button('移除配置')); await wait('settingsFixture.pending.length===3');
  ensure(await evaluate('settingsFixture.requests[0].aborted&&settingsFixture.requests[1].aborted'), 'removing the configuration cancels both active provider probes');
  await evaluate('settingsFixture.pending.splice(2,1)[0]()'); await wait(`!${button('移除配置')}`);
  await evaluate('settingsFixture.release()'); await sleep(120);
  ensure(await evaluate(`!${form}.querySelector('[aria-controls$="-model-options"]')&&!${form}.textContent.includes('已获取')`), 'late model results cannot repopulate removed provider settings');

  for (const fail of [false, true]) {
    await fresh(); await evaluate(`settingsFixture.hold=true;settingsFixture.ignoreAbort=true;settingsFixture.fail=${fail}`); await click(button('移除配置'));
    await evaluate('settingsFixture.switchAccount()'); await wait(`document.querySelector('#translation-model')?.value==='other-account-model'`);
    ensure(await evaluate('settingsFixture.requests[0].aborted'), 'account switch aborts an old removal');
    await evaluate('settingsFixture.release()'); await sleep(120);
    ensure(await evaluate(`document.querySelector('#translation-model').value==='other-account-model'&&!${form}.querySelector('[role=alert], [role=status]')&&settingsFixture.settings['settings-b'].api_key_configured`), 'late removal ' + (fail?'failure':'success') + ' never changes the new account UI');
  }

  await fresh(); await evaluate('settingsFixture.hold=true'); await click(button('移除配置'));
  await evaluate(`document.querySelectorAll('.settings-disclosure')[1].open=true`); await click(`${channelRow('settings-a-1')}.querySelector('[data-channel-action=edit]')`);
  const editor = `document.querySelector('[aria-label="翻译渠道设置"] form')`;
  const probe = `Array.from(${editor}.querySelectorAll('button')).find(e=>e.textContent.trim()==='获取模型列表')`;
  await evaluate('settingsFixture.channelHold=true'); await click(probe); await evaluate('settingsFixture.release()');
  await wait(`!${button('移除配置')}`);
  ensure(await evaluate('document.activeElement===document.body'), 'provider removal cannot steal focus from a later busy manual-channel editor');
  await evaluate('settingsFixture.releaseChannels()'); await wait(`${editor}.textContent.includes('已获取最新模型列表')`); await wait(`document.activeElement===${probe}`);
  ensure(await evaluate(`document.activeElement===${probe}`), 'the later manual-channel probe keeps its own focus return');
}
