import fs from 'node:fs';
import path from 'node:path';

/** Keep a series usable when its layout changes and when returning to the shelf. */
export async function verifySeriesContinuity({ command, evaluate, wait, ensure, click, sleep, origin, reportDir }) {
  const toggles = `document.querySelectorAll('.library-page button[aria-controls][aria-expanded]')`;
  const settled = `document.querySelector('[data-navigation-loading]')?.dataset.navigationLoading==='false'`;
  const press = async (key, modifiers = 0) => {
    const code = key === ' ' ? 'Space' : key;
    const windowsVirtualKeyCode = { Enter: 13, Tab: 9, ' ': 32 }[key];
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers, text: key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
    await sleep(100);
  };
  const visibleToggle = `(()=>{const e=window.seriesToggle,r=e.getBoundingClientRect(),nav=document.querySelector('.mobile-bottom-nav'),bottom=nav&&getComputedStyle(nav).display!=='none'?nav.getBoundingClientRect().top:innerHeight;return r.top>=0&&r.bottom<=bottom&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`;
  const visibleFirstBook = `(()=>{const book=document.querySelector('[data-expanded-series-book] [data-book-id]'),r=book.getBoundingClientRect(),top=Math.max(0,document.querySelector('.topbar-shell').getBoundingClientRect().bottom)+8,nav=document.querySelector('.mobile-bottom-nav'),bottom=(nav&&getComputedStyle(nav).display!=='none'?nav.getBoundingClientRect().top:innerHeight)-8;return r.top>=top&&r.bottom<=bottom})()`;
  const pointerToggle = async (touch) => {
    const point = await evaluate(`(()=>{seriesToggle.scrollIntoView({block:'center'});const r=seriesToggle.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (touch) {
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    }
    await sleep(180);
  };
  for (const [width, height, touch, grid, theme] of [[1536, 864, false, true, 'dark'], [390, 844, true, true, 'light'], [1024, 768, true, true, 'dark'], [1536, 864, false, false, 'light'], [390, 844, true, false, 'dark'], [1024, 768, true, false, 'light']]) {
    const label = `${width} ${grid ? 'grid' : 'list'} ${theme}`;
    console.log('CHECK ' + label + ' series continuity');
    await command('Page.navigate', { url: 'about:blank' });
    await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
    await command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await command('Page.navigate', { url: origin + `/scripts/quality/library-search/fixture.html?manualPaging&series&theme=${theme}${grid ? '&grid' : ''}` });
    await wait(settled + `&&${toggles}.length>0`);
    while (await evaluate(`document.querySelector('[data-navigation-has-more]').dataset.navigationHasMore==='true'`)) {
      await evaluate(`document.querySelector('[data-shelf-footer] button').scrollIntoView({block:'center'})`);
      await click(`document.querySelector('[data-shelf-footer] button')`);
      await wait(settled);
    }
    await evaluate(`window.seriesToggle=Array.from(${toggles}).at(-2);window.seriesPanelId=seriesToggle.getAttribute('aria-controls');seriesToggle.scrollIntoView({block:'center'});seriesToggle.focus({preventScroll:true})`);
    await press('Tab', 8); await press('Tab');
    await wait(`document.activeElement===window.seriesToggle&&seriesToggle.matches(':focus-visible')`);
    const entry = await evaluate(`({key:searchFixture.location.key,url:location.href})`);
    await press('Enter');
    await wait(`!!document.querySelector('[data-expanded-series-book]')`);
    ensure(await evaluate(`seriesToggle.isConnected&&document.activeElement===seriesToggle&&seriesToggle.getAttribute('aria-expanded')==='true'`), label + ' expanding preserves the same focused series control');
    ensure(await evaluate(visibleToggle), label + ' expanded control stays visible above the bottom navigation');
    ensure(await evaluate(visibleFirstBook), label + ' keyboard expansion reveals the entire first book below the search bar');
    ensure(await evaluate(`document.getElementById(seriesPanelId)?.querySelectorAll('[data-book-id]').length===6`), label + ' the expanded control identifies all six visible volumes');
    const documentNode = await command('DOM.getDocument');
    const toggleNode = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '[data-expanded-series-book] button[aria-expanded]' });
    const accessibility = await command('Accessibility.getPartialAXTree', { nodeId: toggleNode.nodeId, fetchRelatives: false });
    const axButton = accessibility.nodes.find(node => node.role?.value === 'button');
    ensure(Boolean(axButton?.name?.value.includes('来信系列') && axButton.properties?.find(property => property.name === 'expanded')?.value.value === true), label + ' accessibility reports a named expanded series button', accessibility.nodes);
    await press('Tab');
    ensure(await evaluate(`!!document.activeElement.closest('[data-book-id]')`), label + ' Tab continues into the expanded books');
    await press('Tab', 8);
    ensure(await evaluate(`document.activeElement===seriesToggle`), label + ' Shift Tab returns to the series toggle');
    await press(' ');
    await wait(`!document.querySelector('[data-expanded-series-book]')`);
    ensure(await evaluate(`seriesToggle.isConnected&&document.activeElement===seriesToggle&&seriesToggle.getAttribute('aria-expanded')==='false'`), label + ' Space collapses the series without losing focus');
    ensure(await evaluate(visibleToggle), label + ' collapsed series remains in view at the end of a long shelf');
    ensure(await evaluate(`searchFixture.location.key===${JSON.stringify(entry.key)}&&location.href===${JSON.stringify(entry.url)}`), label + ' toggling does not create navigation history or alter filters');
    await press('Enter'); await wait(`!!document.querySelector('[data-expanded-series-book]')`);
    await press('Enter'); await wait(`!document.querySelector('[data-expanded-series-book]')`);
    ensure(await evaluate(`document.activeElement===seriesToggle&&seriesToggle.isConnected`), label + ' repeated keyboard toggles remain usable');
    const picture = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(reportDir, `series-${width}-${grid ? 'grid' : 'list'}-${theme}.png`), Buffer.from(picture.data, 'base64'));

    await pointerToggle(touch); await wait(`seriesToggle.getAttribute('aria-expanded')==='true'`);
    ensure(await evaluate(`seriesToggle.isConnected&&!!document.getElementById(seriesPanelId)`), label + ' pointer activation expands once and keeps its original control');
    ensure(await evaluate(visibleFirstBook), label + ' pointer expansion reveals the entire first book above the bottom navigation');
    const expandedPicture = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(reportDir, `series-${width}-${grid ? 'grid' : 'list'}-${theme}-expanded.png`), Buffer.from(expandedPicture.data, 'base64'));
    await pointerToggle(touch); await wait(`seriesToggle.getAttribute('aria-expanded')==='false'`);
    ensure(await evaluate(`seriesToggle.isConnected&&!document.querySelector('[data-expanded-series-book]')`), label + ' pointer activation collapses once without leaving an expanded panel');
    ensure(await evaluate(visibleToggle), label + ' pointer collapse leaves its series visible for the next action');

    // An expanded series must be restored together with every loaded page.
    await evaluate(`seriesToggle.scrollIntoView({block:'center'});seriesToggle.focus({preventScroll:true})`);
    await press('Enter'); await wait(`!!document.querySelector('[data-expanded-series-book]')`);
    await evaluate(`window.returnBook=document.querySelector('[data-expanded-series-book] [data-book-id]');returnBook.scrollIntoView({block:'center'})`);
    await sleep(200);
    const before = await evaluate(`({id:returnBook.dataset.bookId,top:returnBook.getBoundingClientRect().top,pages:document.querySelector('[data-navigation-pages]').dataset.navigationPages})`);
    await evaluate(`searchFixture.navigate('/settings')`); await wait(`location.pathname==='/settings'`);
    await evaluate(`searchFixture.navigate(-1)`); await wait(settled + `&&!!document.querySelector('[data-expanded-series-book] [data-book-id]')`);
    await sleep(300);
    const restored = await evaluate(`({id:document.querySelector('[data-expanded-series-book] [data-book-id]').dataset.bookId,top:document.querySelector('[data-expanded-series-book] [data-book-id]').getBoundingClientRect().top,pages:document.querySelector('[data-navigation-pages]').dataset.navigationPages})`);
    ensure(before.id === restored.id && before.pages === restored.pages, label + ' browser Back restores the expanded series and loaded pages', { before, restored });
    ensure(Math.abs(before.top - restored.top) <= 2, label + ' browser Back restores the same book position', { before, restored });
    await evaluate(`window.scrollBy({top:180,behavior:'instant'})`); await sleep(150);
    const beforeRefresh = await evaluate('scrollY');
    const beforeRequests = await evaluate('searchFixture.requests.length');
    await evaluate('window.dispatchEvent(new Event("focus"))');
    await wait(`searchFixture.requests.length>${beforeRequests}&&${settled}`); await sleep(200);
    ensure(await evaluate(`Math.abs(scrollY-${beforeRefresh})<=2&&!!document.querySelector('[data-expanded-series-book]')`), label + ' background refresh does not repeat the expansion scroll or close the series');
    ensure(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), label + ' expanded and restored shelf fits the viewport');
  }
}
