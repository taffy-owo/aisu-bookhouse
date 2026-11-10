import { verifyInvitationWorkflows } from './invitation-workflows.mjs';

export async function verifyInvitations(options) {
  const { evaluate, wait, fresh, probeOnly, observations } = options;
  if (!probeOnly) return verifyInvitationWorkflows(options);
  const panel = `Array.from(document.querySelectorAll('.profile-account-section section')).find(e=>e.querySelector('h2')?.textContent==='邀请')`;
  const create = `Array.from((${panel}).querySelectorAll('button')).find(e=>/^(生成邀请码|重新生成|正在生成…)$/.test(e.textContent.trim()))`;
  const copy = `Array.from((${panel}).querySelectorAll('button')).find(e=>/^(复制邀请码|正在复制…|已复制)$/.test(e.textContent.trim()))`;
  await fresh(320, 640, true, false, 16, 'invitations');
  await wait(`!!(${create})&&!(${create}).disabled`);
  await evaluate(`(()=>{const e=${create};e.click();e.click()})()`);
  await wait('accountFixture.requests.length>0');
  const generation = await evaluate('({writes:accountFixture.requests.length,aborted:accountFixture.requests.filter(r=>r.aborted).length})');
  await evaluate('accountFixture.release()');
  await wait(`!!(${copy})&&!(${create}).disabled`);
  await evaluate(`(()=>{const e=${copy};e.click();e.click()})()`);
  const copies = await evaluate('accountFixture.copies.length');
  await evaluate('accountFixture.releaseCopy()');
  await wait(`(${copy}).textContent.trim()==='已复制'`);
  await evaluate(`accountFixture.hold=true;(${create}).click()`);
  const copyingDuringGeneration = await evaluate(`!(${copy}).disabled`);
  await evaluate(`accountFixture.release()`);
  await wait(`!(${create}).disabled`);
  await evaluate(`accountFixture.hold=true;accountFixture.fail=true;accountFixture.error='生成失败：'+('upstream_service_error_'.repeat(25));(${create}).click()`);
  await evaluate('accountFixture.release()');
  await wait(`!!(${panel}).querySelector('[role=alert]')`);
  const error = await evaluate(`(()=>{const e=(${panel}).querySelector('[role=alert]');return{width:e.clientWidth,scrollWidth:e.scrollWidth}})()`);
  observations.push({ generation, copies, copyingDuringGeneration, error });
  await wait(`!(${create}).disabled`);
  await evaluate(`accountFixture.hold=true;accountFixture.fail=false;accountFixture.acceptThenFail=true;accountFixture.failQuota=true;(${create}).click()`);
  await evaluate('accountFixture.release()');
  await wait(`(${panel}).innerText.includes('邀请额度暂时无法读取')`);
  observations.push(await evaluate(`({displayed:(${panel}).querySelector('.font-mono').textContent,server:accountFixture.quotas['account-a'].invitation.code,copyAllowed:!(${copy}).disabled})`));
}
