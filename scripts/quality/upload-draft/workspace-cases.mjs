/** Navigation, task isolation and responsive layout after separating translation. */
export async function verifyWorkspaces({ evaluate, wait, ensure, fresh, shot, sleep }) {
  for (const [width, height, touch, dark] of [[1536, 960, false, true], [390, 844, true, false]]) {
    const label = `${width} ${dark ? 'dark' : 'light'}`;
    await fresh(`japanese${dark ? '&dark' : ''}`, width, height, touch);
    await wait('document.body.innerText.includes("还没有日文书")');
    ensure(await evaluate(`!['::before','::after'].some(p=>getComputedStyle(document.querySelector('.japanese-page'),p).backgroundImage!=='none')&&getComputedStyle(document.querySelector('.japanese-page-header'),'::before').content==='none'`), label + ' Japanese editor has no tiled petals or oversized lettering');
    ensure(await evaluate('document.documentElement.scrollWidth<=innerWidth&&document.querySelector(".japanese-source-input").getBoundingClientRect().bottom<innerHeight'), label + ' Japanese input fits the first viewport');
    await shot('workspace-japanese-' + width);

    await fresh(`taskMessages${dark ? '&dark' : ''}`, width, height, touch);
    await wait('document.querySelectorAll("[data-task-focus-id^=translation]").length===7');
    await shot('workspace-translations-top-' + width);
    ensure(await evaluate('!document.querySelector("#upload-mode-file")&&!draftFixture.apiReads.some(r=>r.path.endsWith("/uploads/tasks"))'), label + ' translation page has no upload form or upload polling');
    ensure(await evaluate('!document.querySelector("details.translation-create").open&&document.querySelector("[aria-label=翻译记录]").getBoundingClientRect().width>innerWidth*(innerWidth>1024?.6:.75)'), label + ' translation records use the page width');
    const selectFilter = value => evaluate(`Array.from(document.querySelectorAll('[aria-label=筛选翻译任务] button')).find(e=>e.textContent.startsWith(${JSON.stringify(value)})).click()`);
    await selectFilter('进行中');
    ensure(await evaluate('document.querySelectorAll("[data-task-focus-id^=translation]").length===1'), label + ' active filter shows only running tasks');
    await selectFilter('待处理');
    ensure(await evaluate('document.querySelectorAll("[data-task-focus-id^=translation]").length===5'), label + ' attention filter includes failed, paused, quota and review tasks');
    await evaluate('draftFixture.notificationJobs=draftFixture.translationJobs;document.querySelector("button[aria-controls=notification-panel]")?.click();Array.from(document.querySelectorAll("button[aria-label]" )).find(e=>e.getAttribute("aria-label").startsWith("通知")).click()');
    await wait('Array.from(document.querySelectorAll("#notification-panel a")).some(e=>e.getAttribute("href")==="/translations?task=waiting")');
    ensure(await evaluate('Array.from(document.querySelectorAll("#notification-panel a")).some(e=>e.getAttribute("href")==="/books/translated-ready")&&Array.from(document.querySelectorAll("#notification-panel a")).some(e=>e.getAttribute("href")==="/translations")'), label + ' notifications link completed books and all translation records to their own destinations');
    await evaluate('Array.from(document.querySelectorAll("#notification-panel a")).find(e=>e.getAttribute("href")==="/translations?task=waiting").click()');
    await wait('document.activeElement?.dataset.taskFocusId==="translation:waiting"&&!document.querySelector("#notification-panel")');
    await evaluate('draftFixture.navigate("/translations?task=ready")');
    await wait('document.activeElement?.dataset.taskFocusId==="translation:ready"');
    ensure(true, label + ' notification target resets filtering and focuses its exact record');
    ensure(await evaluate('document.querySelector(".topbar-shell").getBoundingClientRect().bottom<0'), label + ' search row scrolls away without overlapping task text');
    await shot('workspace-translations-' + width);
    await evaluate('draftFixture.navigate("/translations");document.querySelector("details.translation-create").open=true');
    await evaluate('window.scrollTo(0,0)');
    await sleep(100);
    ensure(await evaluate('document.documentElement.scrollWidth<=innerWidth&&!!document.querySelector("#translation-source-url")'), label + ' new translation form fits the viewport');
    await shot('workspace-translation-form-' + width);
    await evaluate('document.querySelector("details.translation-create").open=false;document.querySelector("[data-task-focus-control=clear]").click()');
    await wait('draftFixture.clearRequests.length===1&&document.querySelector("[aria-label=翻译记录]").getAttribute("aria-busy")==="false"');
    ensure(await evaluate('draftFixture.clearRequests[0]==="translations"'), label + ' clearing translation history never clears upload history');
    await evaluate('draftFixture.navigate("/upload")');
    await wait('!!document.querySelector("#upload-mode-file")');
    const previousTranslationReads = await evaluate('draftFixture.apiReads.filter(r=>r.path.endsWith("/translations")).length');
    await evaluate('window.dispatchEvent(new Event("focus"))');
    await sleep(150);
    ensure(await evaluate(`!document.querySelector('[data-task-focus-id^="translation:"]')&&draftFixture.apiReads.filter(r=>r.path.endsWith('/translations')).length===${previousTranslationReads}`), label + ' upload page has no translation list or translation polling');
    await shot('workspace-upload-' + width);
  }
}
