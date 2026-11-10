/** Exercise one paginated Japanese shelf round trip using the real page. */
export async function verifyJapaneseShelfContinuity({ command, evaluate, wait, ensure, click, sleep, origin }) {
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: origin + '/scripts/quality/library-search/fixture.html?page=/japanese&japaneseShelf&manualPaging' });
  const settled = `document.querySelector('.japanese-page')?.dataset.navigationLoading==='false'`;
  await wait(settled + `&&document.querySelectorAll('[data-book-id]').length===36`);
  const input = `document.querySelector('[aria-label=搜索书名、作者]')`;
  const submit = async text => {
    await evaluate(`${input}.focus({preventScroll:true});${input}.select()`);
    await command('Input.insertText', { text });
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const initial = await evaluate(`({requests:searchFixture.requests.length,key:searchFixture.location.key})`);
  await evaluate(`${input}.focus()`);
  await command('Input.insertText', { text: '雨后的书' });
  ensure(await evaluate(`searchFixture.requests.length===${initial.requests}&&searchFixture.location.key===${JSON.stringify(initial.key)}&&document.querySelectorAll('[data-book-id]').length===36`), 'Typing a Japanese shelf query keeps the books and does not reload each character');
  await evaluate(`document.querySelector('form[aria-label=全站搜索]').requestSubmit()`);
  await wait(settled + `&&document.querySelector('[data-book-id]').textContent.includes('雨后的书')`);
  ensure(await evaluate(`location.pathname==='/japanese'&&searchFixture.requests.at(-1).language==='ja'`), 'Header search stays within the Japanese shelf');
  await click(`Array.from(document.querySelectorAll('.japanese-shelf-filters button')).find(e=>e.textContent==='未开始')`);
  await wait(settled + `&&new URLSearchParams(location.search).get('shelf')==='unread'`);
  ensure(await evaluate(`new URLSearchParams(location.search).get('q')==='雨后的书'&&searchFixture.requests.at(-1).language==='ja'&&searchFixture.requests.at(-1).shelf==='unread'`), 'Japanese shelf requests retain both the search and reading filter');

  await click(`document.querySelector('[data-shelf-footer] button')`);
  await wait(settled + `&&document.querySelectorAll('[data-book-id]').length===72`);
  await evaluate('document.fonts.ready');
  await evaluate(`document.querySelector('[data-book-id="search-45"]').scrollIntoView({block:'center'})`);
  await sleep(160);
  const before = await evaluate(`({search:location.search,key:searchFixture.location.key,y:scrollY})`);
  await click(`document.querySelector('[data-book-id="search-45"] a')`);
  await wait(`!!document.querySelector('[data-home-book-detail]')`);
  const source = await evaluate('searchFixture.location.state.collectionReturn');
  ensure(source?.pathname === '/japanese' && source.search === before.search && source.key === before.key, 'Japanese book links retain their original shelf entry');

  await evaluate('history.back()');
  await wait(settled + `&&document.querySelectorAll('[data-book-id]').length===72`);
  await wait(`Math.abs(scrollY-${before.y})<3`);
  ensure(await evaluate(`document.querySelector('[aria-label=搜索书名、作者]').value==='雨后的书'&&Array.from(document.querySelectorAll('.japanese-shelf-filters button')).some(e=>e.textContent==='未开始'&&e.getAttribute('aria-pressed')==='true')&&document.querySelector('.japanese-page').dataset.navigationPages==='2'`), 'Back restores the Japanese shelf search, selected filter and second page');
  ensure(await evaluate(`Math.abs(scrollY-${before.y})<3`), 'Back restores the same book position rather than the beginning of the shelf');

  await click(`document.querySelector('[aria-label=清除搜索]')`);
  await wait(settled + `&&document.querySelector('[data-book-id]').textContent.includes('全部')`);
  ensure(await evaluate(`location.pathname==='/japanese'&&!new URLSearchParams(location.search).has('q')&&new URLSearchParams(location.search).get('shelf')==='unread'&&document.activeElement===${input}`), 'Clearing Japanese search keeps the selected reading state and focuses the same search field');

  await evaluate('searchFixture.empty=true');
  await submit('不存在的日文书');
  await wait(settled + `&&document.querySelector('[data-empty-state]')?.textContent.includes('没有找到相关日文书')`);
  ensure(await evaluate(`!document.querySelector('[data-shelf-footer]')&&Array.from(document.querySelectorAll('.japanese-shelf button')).some(e=>e.textContent==='查看全部日文书')`), 'Japanese search has an accurate empty result and a recovery action without a misleading completion footer');
  await evaluate('searchFixture.empty=false');
  await click(`Array.from(document.querySelectorAll('.japanese-shelf button')).find(e=>e.textContent==='查看全部日文书')`);
  await wait(settled + `&&document.querySelectorAll('[data-book-id]').length===36`);
  ensure(await evaluate(`location.pathname==='/japanese'&&!new URLSearchParams(location.search).has('q')&&!new URLSearchParams(location.search).has('shelf')&&${input}.value===''`), 'Empty-result recovery clears both the Japanese query and reading filter');
}
