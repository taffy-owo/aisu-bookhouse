export async function verifyAnalytics({ command, evaluate, wait, ensure, click, fresh, sleep, shot, observations }) {
  const panel = `document.querySelector('.reading-analytics-panel')`;
  const field = label => `Array.from(${panel}.querySelectorAll('dt')).find(e=>e.textContent===${JSON.stringify(label)})?.nextElementSibling.textContent`;
  const tab = async label => {
    await click(`Array.from(${panel}.querySelectorAll('[role=tab]')).find(e=>e.textContent===${JSON.stringify(label)})`);
    await wait(`${panel}.querySelector('[role=tab][aria-selected=true]').textContent===${JSON.stringify(label)}`);
    await sleep(350);
  };
  const key = async name => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name });
    await sleep(80);
  };
  const fits = `(()=>{const p=${panel};return p.scrollWidth<=p.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()`;
  for (const [width, height, touch, dark, font] of [
    [1536, 864, false, false, 16], [1536, 864, false, true, 16],
    [768, 1024, true, false, 16], [768, 1024, true, true, 24],
    [390, 844, true, false, 16], [390, 844, true, true, 16],
    [320, 640, true, false, 24], [320, 640, true, true, 32],
  ]) {
    const label = `${width}x${height} ${dark ? 'dark' : 'light'} ${font}px`;
    await fresh(width, height, touch, dark, font, 'analytics=short');
    await wait(`${field('记录天数')}==='3 天'`);
    ensure(await evaluate(`${field('最长连续')}==='3 天'&&${field('开始记录')}==='11月14日'&&${field('最近记录')}==='11月16日'`), label + ' overview retains all positive days and dates');
    ensure(await evaluate(`${field('活跃日均')}==='不到 1 分钟'&&${field('最佳单日')}==='不到 1 分钟 · 11月14日'`), label + ' short averages and best day remain visible');
    const overviewFits = await evaluate(fits);
    const overflow = overviewFits ? null : await evaluate(`Array.from(${panel}.querySelectorAll('*')).filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({tag:e.tagName,classes:e.className,width:e.clientWidth,scroll:e.scrollWidth,text:e.textContent.slice(0,120)})).slice(0,20)`);
    if (!overviewFits) await shot('analytics-overflow');
    ensure(overviewFits, label + ' overview fits the viewport', overflow);
    await tab('近7天');
    const weekly = await evaluate(`(()=>{const p=${panel},rows=[...p.querySelectorAll('[role=listitem]')];return{summary:p.innerText,rows:rows.map(e=>({label:e.getAttribute('aria-label'),duration:e.lastElementChild.textContent,bar:e.children[1].firstElementChild.getBoundingClientRect().width,x:e.lastElementChild.getBoundingClientRect().x,right:e.lastElementChild.getBoundingClientRect().right,overflow:e.lastElementChild.scrollWidth>e.lastElementChild.clientWidth+1}))}})()`);
    ensure(weekly.summary.includes('活跃 3/7 天') && weekly.summary.includes('日均 不到 1 分钟') && weekly.rows.length === 7, label + ' weekly active days and average use seconds', weekly);
    ensure(weekly.rows.slice(-3).every(r => r.duration === '不到 1 分钟' && r.bar > 0) && weekly.rows.slice(0, 4).every(r => r.duration === '0 分钟' && r.bar === 0), label + ' short reading bars are visible and empty days stay empty', weekly.rows);
    ensure(weekly.rows.every(r => !r.overflow && Math.abs(r.right - weekly.rows[0].right) < 1 && Math.abs(r.x - weekly.rows[0].x) < 1), label + ' full weekly duration labels align without clipping', weekly.rows);
    ensure(await evaluate(fits), label + ' weekly view fits the viewport');
    const tree = await command('Accessibility.getFullAXTree');
    ensure(tree.nodes.filter(n => !n.ignored && n.role?.value === 'listitem' && /^2026-11-/.test(n.name?.value)).length === 7, label + ' every daily row remains accessible with display contents');
    if (width === 1536 || width === 320) { await evaluate(`${width === 320 ? panel + ".querySelector('[role=list]')" : panel}.scrollIntoView({block:'${width === 320 ? 'center' : 'start'}'})`); await shot('analytics-week-' + label.replaceAll(' ', '-')); }
    await tab('月度热力');
    ensure(await evaluate(`${panel}.querySelector('[aria-label="2026-11-16，阅读 不到 1 分钟"][aria-pressed=true]')!==null&&${panel}.querySelector('[role=status]').textContent==='11月16日 · 阅读 不到 1 分钟'`), label + ' calendar announces short reading and selects today');
    const cells = await evaluate(`Array.from(${panel}.querySelectorAll('.reading-calendar-day')).map(e=>{const s=e.firstElementChild,r=s.getBoundingClientRect();return{date:e.getAttribute('aria-label'),w:r.width,h:r.height,active:s.className.includes('bg-accent/25')}})`);
    ensure(cells.every(c => c.w > 0 && Math.abs(c.w - c.h) < 1) && cells.filter(c => c.active).length === 3, label + ' calendar markers stay circular and short days have activity color', cells);
    ensure(await evaluate(fits), label + ' calendar fits the viewport');
    await click(`${panel}.querySelector('.reading-calendar-day[aria-pressed=true]')`);
    await key('ArrowLeft');
    ensure(await evaluate(`document.activeElement.getAttribute('aria-label')==='2026-11-15，阅读 不到 1 分钟'&&document.activeElement.getAttribute('aria-pressed')==='true'&&${panel}.querySelector('[role=status]').textContent==='11月15日 · 阅读 不到 1 分钟'`), label + ' keyboard navigation preserves selected date and duration');
    if (width === 1536 || width === 320) { await evaluate(`${width === 320 ? panel + ".querySelector('[aria-label=每日阅读记录]')" : panel}.scrollIntoView({block:'${width === 320 ? 'center' : 'start'}'})`); await shot('analytics-month-' + label.replaceAll(' ', '-')); }
    observations.push({ label, weekly: weekly.rows, calendarCells: cells.length });
  }
  await fresh(390, 844, true, true, 16, 'analytics=ties');
  await wait(`${field('最佳单日')}==='1 分钟 · 11月16日'`);
  ensure(true, 'best day compares exact seconds when whole minutes tie');
  await fresh(390, 844, true, false, 16, 'analytics=thresholds');
  await tab('月度热力');
  const classes = await evaluate(`['11','12','13','14'].map(day=>${panel}.querySelector('[aria-label^="2026-11-'+day+'，"]').firstElementChild.className)`);
  ensure(classes[0].includes('bg-accent/25') && classes[1].includes('bg-accent/60') && classes[2].includes('bg-accent/60') && classes[3].split(' ').includes('bg-accent'), 'heatmap intensity changes at exact 900 and 1800 second thresholds', classes);
  await fresh(320, 640, true, true, 32, 'analytics=long');
  await tab('近7天');
  const longDurations = await evaluate(`(()=>{const p=${panel};return{text:p.innerText,fits:${fits},overflow:Array.from(p.querySelectorAll('*')).filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({tag:e.tagName,classes:e.className,width:e.clientWidth,scroll:e.scrollWidth,text:e.textContent.slice(0,120)}))}})()`);
  if (!longDurations.fits) await shot('analytics-long-overflow');
  ensure(longDurations.text.includes('23 小时 59 分钟') && longDurations.text.includes('3 小时 1 分钟') && longDurations.fits && !longDurations.overflow.length, 'long duration labels fit at 320px with enlarged text', longDurations);
  await evaluate(`${panel}.querySelector('[role=list]').scrollIntoView({block:'center'})`); await shot('analytics-week-long-320-32px');
  await fresh(320, 640, true, false, 24, 'analytics=empty');
  await wait(`${field('记录天数')}==='0 天'`);
  ensure(await evaluate(`${field('活跃日均')}==='0 分钟'&&${field('最佳单日')}==='暂无'&&${field('最长连续')}==='0 天'`), 'empty overview preserves zero values and no best day');
  await tab('近7天');
  ensure(await evaluate(`${panel}.innerText.includes('活跃 0/7 天')&&Array.from(${panel}.querySelectorAll('[role=listitem]')).every(e=>e.lastElementChild.textContent==='0 分钟'&&e.children[1].firstElementChild.getBoundingClientRect().width===0)`), 'empty week has seven zero days without phantom bars');
  await tab('月度热力');
  ensure(await evaluate(`${panel}.querySelector('[role=status]').textContent==='11月16日 · 阅读 0 分钟'&&${fits}`), 'empty calendar is usable and announces zero duration');
}
