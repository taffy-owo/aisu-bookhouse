export async function verifyAccountForms({ command, evaluate, wait, ensure, input, click, fresh, openNickname, openPassword, submitTwice, sleep, shot }) {
  const form = operation => `document.querySelector('form[aria-label=${operation === 'nickname' ? '修改昵称' : '修改密码'}]')`;
  const trigger = operation => operation === 'nickname' ? 'document.querySelector("button[aria-label=修改昵称]")' : 'Array.from(document.querySelectorAll(".profile-account-section button")).find(e=>e.textContent.trim()==="修改密码")';
  const open = async operation => operation === 'nickname' ? openNickname() : openPassword();
  const count = operation => `accountFixture.requests.filter(r=>r.operation==='${operation}').length`;
  const longError = '连接未完成：' + 'upstream_provider_request_failed_'.repeat(20) + '\n请稍后重试，输入内容仍会保留。';
  const fits = `(()=>{const e=document.querySelector('.profile-account-section [role=alert]');return !!e&&e.scrollWidth<=e.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()`;
  const values = operation => operation === 'nickname'
    ? `document.querySelector('input[aria-label=昵称]').value==='新的昵称'`
    : `['当前密码','新密码','确认新密码'].map(label=>document.querySelector('input[aria-label="'+label+'"]').value).join('|')==='old-password|new-password|new-password'`;
  const key = async name => { await command('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: name === 'Escape' ? 27 : 13, ...(name === 'Enter' ? { text: '\r' } : {}) }); await command('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: name === 'Escape' ? 27 : 13 }); await sleep(120); };
  for (const [width, height, touch, dark, font] of [
    [1536, 864, false, false, 16], [1536, 864, false, true, 16],
    [768, 1024, true, false, 16], [768, 1024, true, true, 16],
    [390, 844, true, true, 16], [320, 640, true, false, 16],
    [390, 844, true, true, 32], [844, 390, true, false, 32],
  ]) for (const operation of ['nickname', 'password']) {
    const label = `${width}x${height} ${dark ? 'dark' : 'light'} ${font}px ${operation}`;
    await fresh(width, height, touch, dark, font); await open(operation);
    ensure(await evaluate(`document.activeElement===document.querySelector('input[aria-label=${operation === 'nickname' ? '昵称' : '当前密码'}]')`), label + ' opening focuses the first input');
    await evaluate(`accountFixture.fail=true;accountFixture.error=${JSON.stringify(longError)}`);
    await submitTwice(operation); await wait(count(operation) + '>0');
    ensure(await evaluate(count(operation)) === 1, label + ' same-turn duplicate submits send one write');
    ensure(await evaluate(`${form(operation)}.getAttribute('aria-busy')==='true'&&Array.from(${form(operation)}.querySelectorAll('input,button')).every(e=>e.disabled)`), label + ' pending writes disable the form and expose busy state');
    await evaluate(`${form(operation)}.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    ensure(await evaluate(count(operation)) === 1, label + ' an additional pending submit cannot start a write');
    await evaluate('accountFixture.release()');
    await wait(`!!document.querySelector('.profile-account-section [role=alert]')&&${form(operation)}.getAttribute('aria-busy')==='false'`);
    ensure(await evaluate(values(operation)), label + ' failure preserves all entered values');
    ensure(await evaluate(`document.querySelector('.profile-account-section [role=alert]').textContent===${JSON.stringify(longError)}`), label + ' the complete server error remains readable');
    ensure(await evaluate(fits), label + ' long errors wrap without horizontal overflow');
    await evaluate(`document.querySelector('.profile-account-section [role=alert]').scrollIntoView({block:'center'})`);
    if ((width === 320 || width === 1536 && dark) && font === 16) await shot(label.replaceAll(' ', '-') + '-failure');
    const editSelector = operation === 'nickname' ? 'input[aria-label=昵称]' : 'input[aria-label=确认新密码]';
    await input(editSelector, operation === 'nickname' ? '重试后的昵称' : 'new-password');
    await evaluate('accountFixture.hold=true;accountFixture.fail=false');
    const submitButton = `${form(operation)}.querySelector('button[type=submit]')`;
    await click(submitButton);
    await wait(count(operation) + '===2');
    ensure(await evaluate(`!document.querySelector('.profile-account-section [role=alert]')&&${form(operation)}.getAttribute('aria-busy')==='true'`), label + ' retry clears the old error and acquires a new request lock');
    await evaluate('accountFixture.release()');
    await wait(`!${form(operation)}`); await sleep(100);
    ensure(await evaluate(`document.activeElement===(${trigger(operation)})`), label + ' success restores focus to the entry button');
    ensure(await evaluate(operation === 'nickname' ? `accountFixture.session.nickname==='重试后的昵称'&&JSON.parse(localStorage.getItem('aisu-bookhouse:session')).nickname==='重试后的昵称'` : `Array.from(document.querySelectorAll('.profile-account-section [role=status]')).some(e=>e.textContent==='密码已更新')`), label + ' success updates the visible account state once');
    await open(operation);
    if (operation === 'password') ensure(await evaluate(`!document.querySelector('.profile-account-section [role=status]')`), label + ' reopening clears the prior success notice');
    await key('Escape'); await wait(`!${form(operation)}`);
    ensure(await evaluate(`document.activeElement===(${trigger(operation)})&&!document.querySelector('.profile-account-section [role=alert]')`), label + ' Escape closes the editor and restores focus');
  }
  for (const operation of ['nickname', 'password']) for (const fail of [false, true]) {
    await fresh(); await open(operation);
    await evaluate(`accountFixture.ignoreAbort=true;accountFixture.fail=${fail}`);
    await submitTwice(operation); await wait(count(operation) + '===1');
    await evaluate('accountFixture.switchAccount()');
    await wait(`accountFixture.session?.id==='account-b'&&!!document.querySelector('.profile-page')`);
    ensure(await evaluate(`accountFixture.requests[0].aborted&&!${form(operation)}`), operation + ' account switch aborts the old write and clears its editor');
    await evaluate('accountFixture.release()'); await sleep(180);
    ensure(await evaluate(`accountFixture.session.id==='account-b'&&accountFixture.session.nickname==='另一个账号'&&JSON.parse(localStorage.getItem('aisu-bookhouse:session')).id==='account-b'&&!document.querySelector('.profile-account-section [role=alert],.profile-account-section [role=status]')`), operation + ' late ' + (fail ? 'failure' : 'success') + ' cannot overwrite the new account or show stale feedback');
  }
  for (const operation of ['nickname', 'password']) {
    await fresh(); await open(operation);
    await evaluate('accountFixture.ignoreAbort=true;accountFixture.fail=true');
    await submitTwice(operation); await wait(count(operation) + '===1');
    await evaluate('accountFixture.navigate("/away")'); await wait('!!document.querySelector("#reopen")');
    ensure(await evaluate('accountFixture.requests[0].aborted'), operation + ' leaving the page cancels its pending write');
    await evaluate('accountFixture.release()'); await sleep(100); await click('document.querySelector("#reopen")');
    await wait('!!document.querySelector(".profile-page")');
    ensure(await evaluate(`!${form(operation)}&&!document.querySelector('.profile-account-section [role=alert],.profile-account-section [role=status]')`), operation + ' returning does not revive a cancelled editor or stale error');
  }
  await fresh(390, 844, true, true); await openPassword();
  for (const [next, confirm, message] of [
    ['short', 'short', '新密码至少需要 8 位'],
    ['new-password', 'different-password', '两次输入的新密码不一致'],
    ['old-password', 'old-password', '新密码不能与当前密码相同'],
    ['长'.repeat(25), '长'.repeat(25), '新密码过长，请减少字符后重试。'],
  ]) {
    await input('input[aria-label=新密码]', next); await input('input[aria-label=确认新密码]', confirm);
    await evaluate(`${form('password')}.requestSubmit()`);
    await wait(`document.querySelector('.profile-account-section [role=alert]')?.textContent===${JSON.stringify(message)}`);
    ensure(await evaluate('accountFixture.requests.length===0&&document.querySelector("input[aria-label=新密码]").disabled===false'), 'invalid password ' + message + ' does not acquire or strand a request lock');
  }
  await input('input[aria-label=新密码]', 'new-password'); await input('input[aria-label=确认新密码]', 'new-password');
  await evaluate(`accountFixture.hold=false;document.querySelector('input[aria-label=确认新密码]').focus()`); await key('Enter');
  await wait(`!${form('password')}`);
  ensure(await evaluate(count('password')) === 1, 'a valid password remains savable after validation errors');
  await fresh(320, 640, true); await openNickname();
  await input('input[aria-label=昵称]', '   '); await submitTwice('nickname');
  await wait(`document.querySelector('#profile-nickname-error')?.textContent==='昵称不能为空'`);
  ensure(await evaluate(`accountFixture.requests.length===0&&!document.querySelector('input[aria-label=昵称]').disabled`), 'an empty nickname does not acquire or strand a request lock');
  await input('input[aria-label=昵称]', '  输入后的昵称  ');
  await evaluate(`accountFixture.hold=false;document.querySelector('input[aria-label=昵称]').focus()`); await key('Enter');
  await wait(`!${form('nickname')}`);
  ensure(await evaluate(`accountFixture.session.nickname==='输入后的昵称'&&${count('nickname')}===1`), 'Enter saves one trimmed nickname after a validation error');
  await fresh(); await openNickname(); await openPassword();
  await evaluate('accountFixture.fail=true');
  await submitTwice('nickname'); await submitTwice('password');
  await wait('accountFixture.requests.length===2');
  ensure(await evaluate(`${count('nickname')}===1&&${count('password')}===1`), 'nickname and password saves each own an independent lock');
  await evaluate('accountFixture.release()');
  await wait(`document.querySelectorAll('.profile-account-section [role=alert]').length===2`);
  ensure(await evaluate(`${form('nickname')}.getAttribute('aria-busy')==='false'&&${form('password')}.getAttribute('aria-busy')==='false'`), 'independent failures release both form locks');
}
