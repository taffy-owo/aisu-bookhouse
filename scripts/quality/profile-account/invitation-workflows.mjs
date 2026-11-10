export async function verifyInvitationWorkflows({ command, evaluate, wait, ensure, click, fresh, sleep, shot }) {
  const panel = `Array.from(document.querySelectorAll('.profile-account-section section')).find(e=>e.querySelector('h2')?.textContent==='邀请')`;
  const create = `Array.from((${panel}).querySelectorAll('button')).find(e=>/^(生成邀请码|重新生成|正在生成…)$/.test(e.textContent.trim()))`;
  const copy = `Array.from((${panel}).querySelectorAll('button')).find(e=>/^(复制邀请码|正在复制…|已复制)$/.test(e.textContent.trim()))`;
  const retry = `(${panel}).querySelector('[aria-label=重试邀请额度]')`;
  const code = `(${panel}).querySelector('.font-mono')?.textContent`;
  const writes = `accountFixture.requests.filter(r=>r.operation==='invitation').length`;
  const ready = async () => wait(`!!(${create})&&!(${create}).disabled`);
  const freshInvitation = async (...args) => { await fresh(...args, 'invitations'); await ready(); };
  const generate = async () => { await evaluate(`accountFixture.hold=false;(${create}).click()`); await wait(`!!(${copy})&&!(${create}).disabled`); };
  const duplicate = async expression => evaluate(`(()=>{const e=${expression};e.click();e.click()})()`);
  for (const [width, height, touch, dark, font] of [
    [1536, 864, false, false, 16], [1536, 864, false, true, 16],
    [768, 1024, true, false, 16], [390, 844, true, true, 16],
    [320, 640, true, false, 16], [390, 844, true, true, 32], [844, 390, true, false, 32],
  ]) {
    const label = `${width}x${height} ${dark ? 'dark' : 'light'} ${font}px invitations`;
    await freshInvitation(width, height, touch, dark, font);
    await duplicate(create); await wait(writes + '>0');
    ensure(await evaluate(writes) === 1, label + ' duplicate generation starts one write');
    ensure(await evaluate(`(${create}).disabled&&(${create}).textContent.trim()==='正在生成…'`), label + ' generation exposes busy state');
    await evaluate(`(${create}).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    ensure(await evaluate(writes) === 1, label + ' pending generation cannot be re-entered');
    await evaluate('accountFixture.release()'); await ready();
    ensure(await evaluate(code) === 'INVITE0001', label + ' confirmed generation displays the new code');
    await duplicate(copy);
    ensure(await evaluate('accountFixture.copies.length') === 1, label + ' duplicate copy invokes the clipboard once');
    ensure(await evaluate(`(${copy}).disabled&&(${copy}).textContent.trim()==='正在复制…'`), label + ' a pending copy stays busy');
    await evaluate('accountFixture.releaseCopy()'); await wait(`(${copy}).textContent.trim()==='已复制'`);
    await evaluate(`accountFixture.holdCopy=true;(${copy}).click()`);
    await wait('accountFixture.copies.length===2');
    await evaluate(`accountFixture.hold=true;(${create}).click()`);
    ensure(await evaluate(`(${copy}).disabled&&(${panel}).innerText.includes('正在更新')`), label + ' regeneration disables copying the old code');
    await evaluate(`(${copy}).dispatchEvent(new MouseEvent('click',{bubbles:true}));accountFixture.releaseCopy()`); await sleep(80);
    ensure(await evaluate(`accountFixture.copies.length===2&&(${copy}).textContent.trim()!=='已复制'`), label + ' late old-code copy results cannot report success during regeneration');
    await evaluate('accountFixture.release()'); await ready();
    ensure(await evaluate(`${code}==='INVITE0002'&&!(${copy}).disabled&&(${copy}).textContent.trim()==='复制邀请码'`), label + ' a newly generated code has a fresh copy action');
    await evaluate(`accountFixture.failCopy=true;(${copy}).click()`);
    await wait(`(${panel}).innerText.includes('复制失败，请选中上方邀请码手动复制。')`);
    ensure(await evaluate(`!(${copy}).disabled&&getComputedStyle((${panel}).querySelector('.font-mono')).userSelect==='all'`), label + ' a clipboard failure releases the lock and preserves manual copying');
    await evaluate(`accountFixture.failCopy=false;(${copy}).click()`); await wait(`(${copy}).textContent.trim()==='已复制'`);
    ensure(await evaluate(`accountFixture.copies.length===4&&accountFixture.copies.at(-1)==='INVITE0002'&&!(${panel}).querySelector('[role=alert]')`), label + ' clipboard retry uses the current code and clears the error');
    const longError = '生成失败：' + 'upstream_service_error_'.repeat(25) + '\n请重试。';
    await evaluate(`accountFixture.hold=true;accountFixture.fail=true;accountFixture.holdQuota=true;accountFixture.error=${JSON.stringify(longError)};(${create}).click();accountFixture.release()`);
    await wait(`accountFixture.pendingQuota.length>0&&!!(${panel}).querySelector('[role=alert]')`);
    ensure(await evaluate(`(${copy}).disabled&&(${panel}).innerText.includes('正在确认生成结果')`), label + ' a failed regeneration waits for a quota read before enabling old-code copying');
    const geometry = await evaluate(`(()=>{const e=(${panel}).querySelector('[role=alert]');return{width:e.clientWidth,scrollWidth:e.scrollWidth,page:document.documentElement.scrollWidth,viewport:innerWidth}})()`);
    ensure(geometry.scrollWidth <= geometry.width + 1 && geometry.page <= geometry.viewport, label + ' long generation errors fit the viewport', geometry);
    ensure(await evaluate(`(${panel}).querySelector('[role=alert]').textContent===${JSON.stringify(longError)}`), label + ' generation diagnostics retain their complete original text');
    if (width === 320 || width === 1536 && dark) { await evaluate(`(${panel}).querySelector('[role=alert]').scrollIntoView({block:'center'})`); await shot(label.replaceAll(' ', '-') + '-failure'); }
    await evaluate('accountFixture.releaseQuota()'); await ready();
    ensure(await evaluate(`${code}==='INVITE0002'&&!(${copy}).disabled`), label + ' a successful quota read verifies that the old code is still available');
    await evaluate(`accountFixture.fail=false;accountFixture.acceptThenFail=true;accountFixture.failQuota=true;accountFixture.hold=false;(${create}).click()`);
    await wait(`(${panel}).innerText.includes('邀请额度暂时无法读取')`);
    ensure(await evaluate(`${code}==='INVITE0002'&&accountFixture.quotas['account-a'].invitation.code==='INVITE0004'&&(${copy}).disabled&&(${create}).disabled&&(${panel}).innerText.includes('生成结果尚未确认')`), label + ' a lost mutation response cannot expose a possibly revoked code as copyable');
    const beforeRetry = await evaluate(writes);
    await evaluate('accountFixture.failQuota=false;accountFixture.holdQuota=true'); await click(retry);
    await wait('accountFixture.pendingQuota.length>0');
    await evaluate('accountFixture.releaseQuota()'); await ready();
    await wait(`${code}==='INVITE0004'&&!(${copy}).disabled&&!(${panel}).querySelector('[role=alert]')`);
    ensure(true, label + ' read retry recovers the accepted code and clears the obsolete mutation error');
    ensure(await evaluate(writes) === beforeRetry, label + ' quota reconciliation never generates another invitation');
    await evaluate(`accountFixture.acceptThenFail=false;accountFixture.failQuota=true;accountFixture.hold=false;(${create}).click()`);
    await wait(`(${panel}).innerText.includes('邀请额度暂时无法读取')`);
    ensure(await evaluate(`${code}==='INVITE0005'&&!(${copy}).disabled&&(${create}).disabled`), label + ' a confirmed new code remains copyable when the following quota read fails');
  }
  for (const fail of [false, true]) {
    await freshInvitation(1536, 864, false, false, 16);
    await evaluate(`accountFixture.ignoreAbort=true;accountFixture.fail=${fail};(${create}).click()`);
    await wait(writes + '===1'); await evaluate('accountFixture.switchAccount()');
    await wait(`accountFixture.session?.id==='account-b'&&!!(${create})&&!(${create}).disabled`);
    ensure(await evaluate(`accountFixture.requests[0].aborted&&!(${copy})`), 'account switching cancels old invitation generation and hides its code');
    await evaluate(`accountFixture.fail=false;(${create}).click()`); await wait(writes + '===2');
    await evaluate('accountFixture.release()'); await ready();
    ensure(await evaluate(`${code}==='INVITE0002'&&accountFixture.quotas['account-b'].invitation.code==='INVITE0002'&&!(${panel}).querySelector('[role=alert]')`), 'old invitation ' + (fail ? 'failure' : 'success') + ' cannot overwrite the new account or retain its request lock');
  }
  await freshInvitation(390, 844, true, true, 16); await generate();
  await click(copy); await wait('accountFixture.copies.length===1');
  await evaluate('accountFixture.switchAccount()');
  await wait(`accountFixture.session?.id==='account-b'&&!!(${create})&&!(${create}).disabled`);
  await click('document.querySelector("[aria-label=个人中心分类] button:last-child")');
  await generate(); await click(copy); await wait('accountFixture.copies.length===2');
  await evaluate('accountFixture.releaseCopy()'); await wait(`(${copy}).textContent.trim()==='已复制'`);
  ensure(await evaluate(`accountFixture.copies.join('|')==='INVITE0001|INVITE0002'&&${code}==='INVITE0002'`), 'an old account clipboard completion cannot clear the new account copy state');
  await sleep(1500);
  ensure(await evaluate(`(${copy}).textContent.trim()==='复制邀请码'&&!(${copy}).disabled`), 'the copied notice expires and restores the copy action');
  await freshInvitation(1536, 864, false, false, 16);
  await evaluate(`accountFixture.ignoreAbort=true;accountFixture.fail=true;(${create}).click()`);
  await wait(writes + '===1'); await evaluate('accountFixture.navigate("/away")'); await wait('!!document.querySelector("#reopen")');
  ensure(await evaluate('accountFixture.requests[0].aborted'), 'leaving the page aborts pending invitation generation');
  await evaluate('accountFixture.release()'); await click('document.querySelector("#reopen")'); await ready();
  ensure(await evaluate(`!(${panel}).querySelector('[role=alert]')&&!(${copy})`), 'returning does not restore cancelled invitation errors or copy state');
  for (const status of ['used', 'revoked']) {
    await freshInvitation(320, 640, true, false, 16); await generate();
    await evaluate(`accountFixture.quotas['account-a'].invitation.status='${status}';accountFixture.quotas['account-a'].can_create=false;accountFixture.navigate('/away')`);
    await wait('!!document.querySelector("#reopen")'); await click('document.querySelector("#reopen")');
    await wait(`!!(${create})&&!!(${copy})`);
    ensure(await evaluate(`(${create}).disabled&&(${copy}).disabled`), status + ' invitations cannot be copied or regenerated without quota');
    await evaluate(`(${create}).dispatchEvent(new MouseEvent('click',{bubbles:true}));(${copy}).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    ensure(await evaluate(`${writes}===1&&accountFixture.copies.length===0`), status + ' invitation guards also reject synthetic duplicate actions');
  }
  await freshInvitation(320, 640, true, false, 16);
  const enter = async expression => {
    await evaluate(`(${expression}).focus()`);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  await enter(create); await wait(writes + '===1'); await evaluate('accountFixture.release()'); await ready();
  ensure(await evaluate(code) === 'INVITE0001', 'Enter generates a single invitation through native keyboard activation');
  await evaluate(`accountFixture.clipboard=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined})`);
  await click(copy); await wait(`(${panel}).innerText.includes('复制失败，请选中上方邀请码手动复制。')`);
  ensure(await evaluate(`!(${copy}).disabled&&accountFixture.copies.length===0`), 'a missing clipboard API offers manual copying without stranding the request lock');
  await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:accountFixture.clipboard})`);
  await enter(copy); await wait('accountFixture.copies.length===1'); await evaluate('accountFixture.releaseCopy()');
  await wait(`(${copy}).textContent.trim()==='已复制'`);
  ensure(await evaluate(`!(${panel}).querySelector('[role=alert]')`), 'Enter retries a failed copy and clears its fallback notice');
}
