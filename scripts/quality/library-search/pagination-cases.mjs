/** Exercise the actual collection footers through keyboard and pointer input. */
export async function verifyPaginationFeedback({ command, evaluate, wait, ensure, click, sleep, origin }) {
  const footer = 'document.querySelector("[data-shelf-footer]")';
  const action = footer + '?.querySelector("button")';
  const settled = 'document.querySelector("[data-navigation-loading]")?.dataset.navigationLoading==="false"';
  const page = n => `document.querySelector('[data-navigation-pages]')?.dataset.navigationPages==='${n}' && ${settled}`;
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers, text: key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
    await sleep(60);
  };
  const focusAction = async () => {
    await evaluate(`${action}.scrollIntoView({block:'center'});${action}.focus({preventScroll:true})`);
    await key('Tab', 'Tab', 9, 8); await key('Tab', 'Tab', 9);
    await wait(`document.activeElement===${action} && document.activeElement.matches(':focus-visible')`);
  };
  const release = async () => evaluate('searchFixture.held.clear();searchFixture.pending.splice(0).forEach(resolve=>resolve())');
  const pointerClick = async expression => { await evaluate(`${expression}.scrollIntoView({block:'center'})`); await sleep(80); await click(expression); };
  for (const [width, height, touch] of [[1536, 864, false], [390, 844, true], [1024, 768, true]]) for (const route of ['/library', '/public']) {
    await command('Page.navigate', { url: 'about:blank' });
    await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
    await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await command('Page.navigate', { url: origin + '/scripts/quality/library-search/fixture.html?manualPaging&page=' + route });
    await wait(page(1));
    const label = width + ' ' + route;
    await evaluate('searchFixture.held.add("page:2");searchFixture.failPage=2');
    await focusAction();
    const before = await evaluate(`({y:scrollY,rows:document.querySelectorAll('[data-book-id]').length,ids:Array.from(document.querySelectorAll('[data-book-id]')).map(e=>e.dataset.bookId)})`);
    await key('Enter', 'Enter', 13);
    await wait(`${footer}.textContent.includes('正在加载更多')`);
    ensure(await evaluate(`${footer}.contains(document.activeElement)`), label + ' keyboard pagination keeps focus inside loading feedback');
    const requestCount = await evaluate('searchFixture.requests.length');
    await key('Enter', 'Enter', 13); await key(' ', 'Space', 32);
    ensure(await evaluate('searchFixture.requests.length') === requestCount, label + ' loading feedback cannot trigger duplicate requests');
    await release(); await wait(`${footer}.textContent.includes('重试加载')`);
    ensure(await evaluate(`document.activeElement===${action}`), label + ' a failed keyboard page load focuses its retry action');
    ensure(await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('[data-book-id]')).map(e=>e.dataset.bookId))`) === JSON.stringify(before.ids), label + ' a failed page load preserves every loaded book');
    await evaluate('searchFixture.failPage=0;searchFixture.held.add("page:2")');
    await key('Enter', 'Enter', 13); await wait(`${footer}.textContent.includes('正在加载更多')`);
    await release(); await wait(page(2));
    ensure(await evaluate(`document.activeElement.closest('[data-book-id]')?.dataset.bookId==='search-'+${before.rows}`), label + ' a successful keyboard retry focuses the first newly loaded book');
    ensure(await evaluate('(()=>{const r=document.activeElement.getBoundingClientRect();return r.bottom>100&&r.top<innerHeight-80})()'), label + ' the newly focused book remains in the visible results');
    ensure(await evaluate(`document.querySelectorAll('[data-book-id]').length`) > before.rows, label + ' successful pagination appends new books');

    // A replacement refresh keeps its list visible and can fail separately.
    await evaluate('searchFixture.failPage=1;window.dispatchEvent(new Event("focus"))');
    await wait(`${footer}.textContent.includes('重试更新')`);
    const refreshRows = await evaluate(`Array.from(document.querySelectorAll('[data-book-id]')).map(e=>e.dataset.bookId)`);
    await evaluate('searchFixture.held.add("page:1")'); await focusAction();
    const refreshY = await evaluate('scrollY');
    await key('Enter', 'Enter', 13); await wait(`${footer}.textContent.includes('正在更新图书')`);
    ensure(await evaluate(`${footer}.contains(document.activeElement) && Math.abs(scrollY-${refreshY})<=1`), label + ' keyboard refresh retry preserves focus and the visible list position');
    await release(); await wait(`${footer}.textContent.includes('重试更新')`);
    ensure(await evaluate(`document.activeElement===${action}`), label + ' a failed refresh retry remains keyboard actionable');
    ensure(await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('[data-book-id]')).map(e=>e.dataset.bookId))`) === JSON.stringify(refreshRows), label + ' a failed refresh does not publish a partial replacement');
    await evaluate('searchFixture.failPage=0;searchFixture.held.add("page:1")');
    await key('Enter', 'Enter', 13); await wait(`${footer}.textContent.includes('正在更新图书')`);
    // A person who leaves pending feedback must retain their newer focus.
    await evaluate('document.querySelector("[aria-label=搜索书名、作者]").focus({preventScroll:true})');
    await release(); await wait(page(2));
    ensure(await evaluate('document.activeElement===document.querySelector("[aria-label=搜索书名、作者]")'), label + ' completion never steals focus after the person moves elsewhere');

    await evaluate('searchFixture.failPage=1;window.dispatchEvent(new Event("focus"))'); await wait(`${footer}.textContent.includes('重试更新')`);
    await evaluate('searchFixture.failPage=0'); await focusAction(); await key('Enter', 'Enter', 13); await wait(settled);
    ensure(await evaluate(`document.activeElement===${action}`), label + ' a fast refresh retry also returns focus to its available action');

    // Complete the final remaining page with a keyboard action.
    while (await evaluate('document.querySelector("[data-navigation-has-more]").dataset.navigationHasMore==="true"')) {
      const nextIndex = await evaluate('document.querySelectorAll("[data-book-id]").length');
      await focusAction(); await key('Enter', 'Enter', 13); await wait(settled);
      ensure(await evaluate(`document.activeElement.closest('[data-book-id]')?.dataset.bookId==='search-${nextIndex}'`), label + ' fast pagination continues at newly appended book ' + nextIndex);
    }
    ensure(await evaluate(`!!document.activeElement.closest('[data-book-id]') && ${footer}.textContent.includes('已显示全部图书')`), label + ' final pagination keeps focus in the newly loaded results');
    const finalRows = await evaluate(`document.querySelectorAll('[data-book-id]').length`);
    ensure(finalRows === 90, label + ' every fixture book is present after retry and final pagination');

    // Pointer retries should not gain a programmatic keyboard focus ring.
    await evaluate('searchFixture.failPage=1;window.dispatchEvent(new Event("focus"))'); await wait(`${footer}.textContent.includes('重试更新')`);
    await evaluate('searchFixture.failPage=0;searchFixture.held.add("page:1")');
    await pointerClick(action); await wait(`${footer}.textContent.includes('正在更新图书')`);
    ensure(!await evaluate(`document.activeElement===${footer}.firstElementChild`), label + ' pointer retries do not move focus onto the status container');
    await release(); await wait(settled);
    ensure(!await evaluate(`document.activeElement===${footer}.firstElementChild`), label + ' pointer completion leaves the status container unfocused');

    // Refresh can remove every book and unmount the footer. Both filtered and
    // unfiltered empty states need an appropriate keyboard destination.
    for (const filtered of [true, false]) {
      if (!filtered) {
        await pointerClick(`document.querySelector('[data-empty-state] button')`); await wait(settled);
        await evaluate('searchFixture.total=90;window.dispatchEvent(new Event("focus"))'); await wait(page(1));
        await wait(`!!${action}`);
      }
      await evaluate('searchFixture.failPage=1;window.dispatchEvent(new Event("focus"))'); await wait(`${footer}.textContent.includes('重试更新')`);
      await evaluate('searchFixture.failPage=0;searchFixture.total=0;searchFixture.held.add("page:1")');
      await focusAction(); await key('Enter', 'Enter', 13); await wait(`${footer}.textContent.includes('正在更新图书')`);
      await release(); await wait(`!${footer} && !!document.querySelector('[data-empty-state]') && ${settled}`);
      ensure(await evaluate(`(()=>{const empty=document.querySelector('[data-empty-state]');return document.activeElement===(empty.querySelector('button,a[href]')||empty)})()`), label + (filtered ? ' an empty refresh focuses the filter recovery action' : ' an empty unfiltered refresh focuses its explanation'));
      if (!filtered) {
        const documentNode = await command('DOM.getDocument');
        const emptyNode = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '[data-empty-state]' });
        const accessibility = await command('Accessibility.getPartialAXTree', { nodeId: emptyNode.nodeId, fetchRelatives: false });
        const title = await evaluate('document.querySelector("[data-empty-state] h3").textContent');
        ensure(accessibility.nodes.some(node => !node.ignored && node.role?.value === 'group' && node.name?.value === title), label + ' empty feedback exposes its accessible explanation');
      }
    }
  }
  for (const [width, height, touch, grid, series] of [[1536, 864, false, true, false], [1536, 864, false, true, true], [1536, 864, false, false, true], [1024, 768, true, true, true]]) {
    await command('Page.navigate', { url: 'about:blank' });
    await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
    await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await command('Page.navigate', { url: origin + '/scripts/quality/library-search/fixture.html?manualPaging&page=/library' + (grid ? '&grid' : '') + (series ? '&series' : '') });
    await wait(page(1));
    const label = width + ' ' + (grid ? 'grid' : 'list') + (series ? ' series' : ' books');
    await evaluate('searchFixture.held.add("page:2")'); await focusAction(); await key('Enter', 'Enter', 13);
    await wait(`${footer}.textContent.includes('正在加载更多')`);
    ensure(await evaluate(`${footer}.contains(document.activeElement)`), label + ' keyboard loading feedback retains focus');
    await release(); await wait(page(2));
    ensure(await evaluate(series
      ? `document.activeElement.matches('button[aria-expanded="false"][aria-controls]') && document.activeElement.textContent.includes('来信系列 7')`
      : `document.activeElement.closest('[data-book-id]')?.dataset.bookId==='search-36'`), label + ' successful pagination focuses the first new visible result');
    ensure(await evaluate('(()=>{const r=document.activeElement.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'), label + ' native keyboard focus brings the full new result into view');
  }
}
