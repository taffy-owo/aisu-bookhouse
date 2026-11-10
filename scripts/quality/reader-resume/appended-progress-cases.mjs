export async function verifyAppendedProgress({ fresh, wait, ensure, evaluate, click, screenshot }) {
  const percent = 'document.querySelector(".book-detail-progress [role=progressbar]")?.getAttribute("aria-valuenow")';
  const current = 'document.querySelector(".book-detail-catalog-content [aria-current=page]")';
  for (const [width, height, touch] of [[1536, 864, false], [768, 1024, true], [390, 844, true]]) {
    await fresh(width, height, touch, 'detail&siteDark&catalogLength=198&appendedProgress=local&holdWrites', false);
    await wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false"');
    await wait(percent + '==="46" && ' + current + '?.textContent.includes("第121话")');
    ensure(await evaluate(percent + '==="46" && document.querySelectorAll(".book-detail-catalog-content a").length===198'), width + ' appended catalog corrects pending 100% to weighted 46%');
    ensure(await evaluate('Array.from(document.querySelectorAll(".book-detail-actions button")).some(e=>e.textContent.trim()==="标记已读")'), width + ' partially read appended book is not shown as finished');
    ensure(await evaluate('resumeFixture.pendingProgress()["resume-test"].epubCfi==="aisu-scroll:0.16"'), width + ' correction preserves the durable chapter offset');
    await screenshot('appended-progress-' + width);
    const resume = 'Array.from(document.querySelectorAll(".book-detail-page a")).find(e=>e.textContent.includes("继续阅读") && e.getBoundingClientRect().height>0)';
    await evaluate(resume + '.scrollIntoView({block:"center"})');
    await click(resume);
    await wait('document.querySelector(".reader-chapter-heading h1")?.textContent==="第121话" && document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');
    ensure(await evaluate('document.querySelector(".reader-chapter-heading h1").textContent==="第121话"'), width + ' continue reading resumes chapter 121 after append');
    await wait('(()=>{const e=document.querySelector(".reader-document-scroll")?document.scrollingElement:document.querySelector(".reader-viewport");return e && Math.abs(e.scrollTop/(e.scrollHeight-e.clientHeight)-.16)<.04})()');
    ensure(true, width + ' continue reading preserves the within-chapter scroll position');
  }
  await fresh(1536, 864, false, 'detail&catalogLength=198&appendedProgress=finished', false);
  await wait('document.querySelector(".book-detail-page")?.dataset.navigationLoading==="false"');
  ensure(await evaluate(percent + '==="100" && Array.from(document.querySelectorAll(".book-detail-actions button")).some(e=>e.textContent.trim()==="标记未读")'), 'explicit manual completion stays finished when no stale pending read exists');
}
