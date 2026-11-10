export async function verifyChapterHistory({ command, ensure, evaluate, fresh, wait, sleep, screenshot }) {
  const scroller = '(document.querySelector(".reader-document-scroll")?document.scrollingElement:document.querySelector(".reader-viewport"))';
  const ready = async () => { await wait('document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"'); await sleep(300); };
  const anchor = () => evaluate(`(()=>{const e=${scroller},top=e===document.scrollingElement?80:e.getBoundingClientRect().top+80;
    const p=[...document.querySelectorAll('.reader-body-text p')].find(p=>p.getBoundingClientRect().bottom>top);
    if(!p)return{};const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),range=document.createRange();let node;
    while((node=walker.nextNode())){if(node.parentElement.closest('rt,rp'))continue;for(let i=0;i<node.length;i++){
      range.setStart(node,i);range.setEnd(node,i+1);const rect=range.getBoundingClientRect();if(rect.bottom>top)return{text:p.textContent,snippet:node.data.slice(i,i+24),y:rect.top,scroll:e.scrollTop};}}return{}})()`);
  const pinned = before => evaluate(`(()=>{const before=${JSON.stringify(before)},p=[...document.querySelectorAll('.reader-body-text p')].find(p=>p.textContent.endsWith(before.text));
    if(!p)return{};const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),range=document.createRange();let node;
    while((node=walker.nextNode())){const i=node.data.indexOf(before.snippet);if(i<0)continue;range.setStart(node,i);range.setEnd(node,i+1);return{snippet:before.snippet,y:range.getBoundingClientRect().top};}return{}})()`);
  for (const [width, height, touch] of [[1536, 864, false], [768, 1024, true], [390, 844, true]]) {
    for (const mode of ['scroll', 'paged']) {
      for (const operation of ['prepend', 'trim', 'inline', 'title', 'start', 'end', 'removed', 'navigation']) {
        const label = `${width} ${mode} closed-chapter ${operation}`;
        await fresh(width, height, touch, 'chapterUpdates&theme=dark' + (mode === 'paged' ? '&paged' : ''));
        await ready();
        const original = await evaluate('(async()=>await(await fetch("/api/v1/books/resume-test/reader/chapters/1")).json())()');
        await evaluate(scroller + '.scrollTop=' + (operation === 'start' ? 0 : operation === 'end' ? 1e9 : 4000));
        await sleep(700);
        const before = await anchor();
        const oldHistory = await evaluate('resumeFixture.chapterHistory()["resume-test"]?.["chapter:key-1"]');
        await evaluate('fixtureNavigate("/library")');
        await wait('!document.querySelector(".reader-body-text")');
        const paragraphs = original.content.split('\n\n');
        const index = paragraphs.indexOf(before.text);
        const content = operation === 'title' ? original.content
          : operation === 'trim' ? paragraphs.slice(10).join('\n\n')
            : operation === 'removed' ? paragraphs.filter((_, i) => Math.abs(i - index) > 5).join('\n\n')
              : operation === 'inline' ? original.content.replace(before.text, '在这一段开头补充的新内容。'.repeat(90) + before.text)
                : Array.from({ length: 20 }, (_, i) => '新增第' + (i + 1) + '段。故事发生前需要补充的内容。').join('\n\n') + '\n\n' + original.content;
        const revised = { content, title: operation === 'title' ? '修改后的话名' : original.title, content_version: 'offline-revision' };
        await evaluate('(()=>{resumeFixture.chapterEdits.set(1,' + JSON.stringify(revised) + ');resumeFixture.resource.toc[0].content_version="offline-revision";resumeFixture.resource.version="2026-11-09T00:00:00Z";})()');
        await evaluate('fixtureNavigate("/reader/novel/resume-test' + (operation === 'navigation' ? '?chapter=2' : '') + '")');
        await ready();
        if (operation === 'navigation') {
          await evaluate('fixtureNavigate("/library")'); await wait('!document.querySelector(".reader-body-text")');
          await evaluate('fixtureNavigate("/reader/novel/resume-test?chapter=1")'); await ready();
        }
        const after = operation === 'inline' ? await pinned(before) : await anchor();
        if (operation === 'start') ensure(await evaluate(scroller + '.scrollTop<=1'), label + ' retains chapter start');
        else if (operation === 'end') ensure(await evaluate('resumeFixture.progress().epub_cfi==="aisu-scroll:1"'), label + ' retains chapter end');
        else if (operation === 'removed') {
          const visibleRatio = await evaluate(`(()=>{const e=${scroller},body=document.querySelector('.reader-body-text'),status=document.querySelector('.reader-reading-status');
            const bottom=e===document.scrollingElement?innerHeight-(status?.getBoundingClientRect().height??26):e.getBoundingClientRect().bottom;
            return e.scrollTop/Math.max(1,Math.min(e.scrollHeight-e.clientHeight,e.scrollTop+body.getBoundingClientRect().bottom-bottom));})()`);
          ensure(Math.abs(visibleRatio - oldHistory.ratio) <= .002, label + ' uses approximate progress when its sentence was removed', { visibleRatio, old: oldHistory.ratio });
        } else ensure(before.snippet === after.snippet && Math.abs(before.y - after.y) <= 3, label + ' restores the surviving sentence at the same screen line', { before, after });
        ensure(await evaluate('!document.querySelector(".reader-chapter-error")'), label + ' remains readable without an error');
        if (operation === 'prepend' && mode === 'scroll') await screenshot('chapter-history-' + width);
      }
    }
  }
}
