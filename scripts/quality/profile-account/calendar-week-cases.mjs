export async function verifyCalendarWeeks({ command, evaluate, wait, ensure, click, fresh, sleep, shot, observations }) {
  await command('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
  const panel = `document.querySelector('.reading-analytics-panel')`;
  const headline = `${panel}.querySelector('[role=tabpanel] > div:first-child').children[2].firstElementChild.textContent`;
  const goal = `${panel}.querySelector('[aria-label=本周阅读目标进度]')`;
  const choice = `${panel}.querySelector('[aria-label="每周阅读 2 小时"]')`;
  const overview = async () => {
    await click(`${panel}.querySelector('[role=tab]:first-child')`);
    await wait(`${goal}!==null`);
  };
  const chart = async () => {
    await click(`Array.from(${panel}.querySelectorAll('[role=tab]')).find(e=>e.textContent==='近7天')`);
    await wait(`${panel}.querySelector('[role=listitem]')!==null`);
  };
  const goHome = async expected => {
    await evaluate(`accountFixture.navigate('/')`);
    await wait(`Array.from(document.querySelectorAll('.reading-summary-stat')).some(e=>e.textContent.includes('本周阅读')&&e.textContent.includes(${JSON.stringify(expected)}))`);
  };
  for (const [width, height, touch, dark, font] of [
    [1536, 864, false, false, 16], [1536, 864, false, true, 16],
    [768, 1024, true, true, 24], [390, 844, true, false, 16], [320, 640, true, true, 32],
  ]) for (const cloud of [false, true]) {
    const label = `${width}x${height} ${dark ? 'dark' : 'light'} ${font}px ${cloud ? 'cloud' : 'local'}`;
    await fresh(width, height, touch, dark, font, 'analytics=calendar&analyticsDate=2026-11-18T12:00:00&weekHome' + (cloud ? '&analyticsCloud' : ''));
    await wait(`${headline}==='53 分钟'&&!!${goal}`);
    const before = await evaluate(`localStorage.getItem('aisu-bookhouse:reading-activity:account-a')`);
    ensure(await evaluate(`${panel}.querySelector('[aria-label=本周统计范围]').textContent==='11月16日–11月22日 · 周一开始'`), label + ' displays the local Monday to Sunday range');
    ensure(await evaluate(`${panel}.textContent.includes('减少 50%')&&${panel}.textContent.includes('上周同期 1 小时 45 分钟')`), label + ' compares Monday to Wednesday with matching prior weekdays');
    await click(choice);
    await wait(`${goal}.getAttribute('aria-valuenow')==='43'`);
    ensure(await evaluate(`${choice}.getAttribute('aria-checked')==='true'&&localStorage.getItem('aisu-weekly-reading-goal:account-a')==='2'`), label + ' the chosen goal uses this week only and persists');
    ensure(await evaluate(`${panel}.scrollWidth<=${panel}.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth`), label + ' range and comparison fit the viewport');
    const choices = await evaluate(`Array.from(${panel}.querySelectorAll('[role=radio]')).map(e=>{const r=e.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(e);const text=range.getBoundingClientRect();return{width:r.width,height:r.height,textWidth:text.width,overflow:e.scrollWidth>e.clientWidth+1}})`);
    ensure(choices.every(c=>c.width>=44&&c.height>=44&&c.textWidth<=c.width-4&&!c.overflow), label + ' all goal options have readable text and touch targets', choices);
    ensure(await evaluate(`Array.from(${panel}.querySelectorAll('p')).filter(e=>e.textContent.startsWith('上周同期')).every(e=>getComputedStyle(e).textOverflow!=='ellipsis'&&e.scrollWidth<=e.clientWidth+1)`), label + ' comparison durations wrap without hiding their text');
    await evaluate(`${goal}.scrollIntoView({block:'center'})`); await shot('calendar-week-' + label.replaceAll(' ', '-'));
    await chart();
    ensure(await evaluate(`${panel}.querySelector('[aria-label="2026-11-15，阅读 3 小时"]')!==null`), label + ' the separately labelled seven-day chart retains prior Sunday reading');
    await overview();
    await evaluate(`accountFixture.setDate('2026-11-22T23:59:59')`);
    await wait(`${panel}.textContent.includes('减少 87%')&&${panel}.textContent.includes('上周同期 6 小时 45 分钟')`);
    ensure(await evaluate(`${headline}==='53 分钟'&&${goal}.getAttribute('aria-valuenow')==='43'`), label + ' Sunday includes the full calendar week without changing the goal');
    ensure(await evaluate(`localStorage.getItem('aisu-bookhouse:reading-activity:account-a')===${JSON.stringify(before)}`), label + ' calendar changes leave saved daily records intact');
    await goHome('53 分钟');
    ensure(true, label + ' home and profile agree on this week');
    observations.push({ label, weekSeconds: 3150, previousToDateSeconds: 6300, chosenGoalHours: 2 });
  }
  await fresh(390, 844, true, true, 16, 'analytics=rollover&analyticsDate=2026-11-15T23:59:59&weekHome');
  await wait(`${headline}==='2 小时'`); await click(choice);
  await wait(`${goal}.getAttribute('aria-valuenow')==='100'`);
  await evaluate(`accountFixture.setDate('2026-11-16T00:00:01')`);
  await wait(`${headline}==='0 分钟'&&${goal}.getAttribute('aria-valuenow')==='0'`);
  ensure(await evaluate(`${choice}.getAttribute('aria-checked')==='true'&&${panel}.querySelector('[aria-label=本周统计范围]').textContent==='11月16日–11月22日 · 周一开始'`), 'crossing Monday resets weekly progress while retaining the chosen hours');
  await chart();
  ensure(await evaluate(`${panel}.querySelector('[aria-label="2026-11-15，阅读 2 小时"]')!==null`), 'Monday rollover retains yesterday in the seven-day chart');
  await goHome('0 分钟');
  ensure(await evaluate(`localStorage.getItem('aisu-bookhouse:reading-activity:account-a')==='{"2026-11-15":7200}'`), 'home rollover does not clear Sunday history');
  await fresh(390, 844, true, false, 16, 'analytics=year&analyticsDate=2026-01-04T23:59:59&weekHome&analyticsCloud');
  await wait(`${headline}==='6 分钟'`);
  ensure(await evaluate(`${panel}.querySelector('[aria-label=本周统计范围]').textContent==='12月29日–1月4日 · 周一开始'`), 'calendar week crosses a year boundary without resetting January history early');
  await evaluate(`accountFixture.setDate('2026-01-05T00:00:01')`);
  await wait(`${headline}==='0 分钟'&&${goal}.getAttribute('aria-valuenow')==='0'`);
  await goHome('0 分钟');
  ensure(true, 'first Monday of the year resets home and profile consistently');
  for (const [timezoneId, date, expected] of [
    ['America/New_York', '2026-01-04T23:59:59', '6 分钟'],
    ['Asia/Shanghai', '2026-01-05T00:00:01', '0 分钟'],
  ]) {
    await command('Emulation.setTimezoneOverride', { timezoneId });
    await fresh(390, 844, true, false, 16, 'analytics=year&analyticsDate=' + date + '&weekHome&analyticsCloud');
    await wait(`${headline}===${JSON.stringify(expected)}`);
    ensure(true, timezoneId + ' uses the reader local week when UTC is on a different date');
    await goHome(expected);
    ensure(true, timezoneId + ' home uses the same local week from cloud daily records');
  }
  await sleep(100);
  await command('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
}
