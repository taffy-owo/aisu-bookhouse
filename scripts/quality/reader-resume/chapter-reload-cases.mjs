/** Native storage and locks must retain a pending write's identity through a full navigation. */
export async function verifyChapterMutationReload({ command, ensure, evaluate, fresh, ready }) {
  const prefix = 'aisu-bookhouse:chapter-mutation-attempt:';
  for (const [width, height, touch] of [[390,844,true],[768,1024,true],[1536,864,false]]) {
    for (const operation of ['append','save','remove']) for (const committed of [false,true]) {
      await fresh(width,height,touch,'persistEditor&theme=dark');
      const revision = operation === 'append' ? null : await evaluate(`import('/src/modules/books/services/bookService.ts').then(api=>api.getEditableBookChapter('resume-test',2)).then(chapter=>chapter.revision)`);
      const input={title:'第2话 修改',content:'跨整页刷新重试，正文不会再执行一次。',contentIsBody:true};
      const request = `import('/src/modules/books/services/bookService.ts').then(api=>api.${operation==='append'?'appendBookChapter':operation==='save'?'updateBookChapter':'deleteBookChapter'}('resume-test',${operation==='append'?JSON.stringify(input):'2,'+(operation==='save'?JSON.stringify(input)+',':'')+'undefined,'+JSON.stringify(revision)}))`;
      const label=`${width} ${operation} reload ${committed?'after commit':'before commit'}`;
      await evaluate(`resumeFixture.editorStatus.${operation}=${committed?-2:-1}`);
      const error=await evaluate(request+'.then(()=>null,error=>error.message)');
      ensure(error?.includes('Failed to fetch')&&await evaluate(`Object.keys(localStorage).filter(k=>k.startsWith(${JSON.stringify(prefix)})).length===1`),label+' keeps only the pending request identity after a lost response');
      const first=await evaluate(`resumeFixture.editorRequests.find(r=>r.operation===${JSON.stringify(operation)})`);
      await command('Page.reload');await ready(1);
      await evaluate(request);
      const expected=operation==='append'?4:operation==='remove'?2:3;
      ensure(await evaluate(`(()=>{const requests=resumeFixture.editorRequests.filter(r=>r.operation===${JSON.stringify(operation)});return requests.length===2&&requests[1].requestId===${JSON.stringify(first.requestId)}&&requests[0].revision===requests[1].revision&&resumeFixture.editorReceipts.size===1&&resumeFixture.resource.chapter_count===${expected}})()`),label+' reuses the original identity and revision and confirms exactly one write');
      ensure(await evaluate(`resumeFixture.resource.toc.some(chapter=>chapter.position_key==='key-3')&&Object.keys(localStorage).every(k=>!k.startsWith(${JSON.stringify(prefix)}))`),label+' preserves the following chapter and releases confirmed retry metadata');
    }
  }
}
