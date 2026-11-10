import { verifyMarkFocusTransitions } from './mark-focus-cases.mjs';
import fs from 'node:fs';
import path from 'node:path';

export async function verifyReaderNavigationUi({ command, ensure, evaluate, fresh, wait, click, reveal, readAt, sleep, screenshot, baseline, reportDir }) {
  const observations=[];
  const scroller='(document.querySelector(".reader-document-scroll")?document.scrollingElement:document.querySelector(".reader-viewport"))';
  const open=async(label,selector)=>{await reveal(`[aria-label="${label}"]`);await click(`document.querySelector('[aria-label="${label}"]')`);await wait(`!!document.querySelector('${selector}')`);await sleep(450);};
  const snapshot=()=>evaluate(`(()=>{const root=document.querySelector('.reader-with-reading-status'),s=${scroller},bar=root.querySelector('.reader-find-bar'),mark=root.querySelector('[data-reader-search-active="true"]');const r=e=>{if(!e)return null;const b=e.getBoundingClientRect();return{top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,height:b.height}};return{scroll:s.scrollTop,height:s.scrollHeight,focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName,find:r(bar),mark:r(mark),result:document.querySelector('#reader-find-result-count')?.textContent,header:r(root.querySelector('.reader-chrome-top')),footer:r(root.querySelector('.reader-bottom-bar'))}})()`);
  const activate=async expression=>{await evaluate(`(${expression}).scrollIntoView({block:'nearest'})`);await click(expression);};
  const replace=async(selector,text)=>{await click(`document.querySelector('${selector}')`);await command('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});await command('Input.insertText',{text});await sleep(350);};
  for(const [width,height,touch,fontSize,theme] of [[1536,864,false,16,'dark'],[768,1024,true,16,'paper'],[390,844,true,16,'dark'],[320,640,true,32,'paper'],[844,390,true,16,'dark'],[320,280,true,16,'dark']]){
    await fresh(width,height,touch,'theme='+theme);
    await evaluate(`document.documentElement.style.fontSize='${fontSize}px'`);await sleep(450);
    await readAt(4000);
    const before=await snapshot();
    await open('打开当前章查找','.reader-find-bar');
    const empty=await snapshot();
    await replace('[aria-label="在当前章查找"]','窗外');
    const found=await snapshot();
    await click('document.querySelector("[aria-label=下一个匹配]")');await sleep(200);
    const next=await snapshot();
    await replace('[aria-label="在当前章查找"]','匹配不到的内容');
    const missing=await snapshot();
    const resultLines=await evaluate(`(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('#reader-find-result-count'));return r.getClientRects().length})()`);
    await screenshot('reader-navigation-find-'+width+'-'+fontSize);
    await click('document.querySelector("[aria-label=关闭查找]")');await sleep(200);
    const closed=await snapshot();
    await open('打开目录','.reader-toc-panel');
    const toc=await evaluate(`(()=>{const p=document.querySelector('.reader-toc-panel');return{width:p.clientWidth,scroll:p.scrollWidth,current:p.querySelector('[aria-current]')?.textContent,top:p.getBoundingClientRect().top,bottom:p.getBoundingClientRect().bottom}})()`);
    await screenshot('reader-navigation-toc-'+width+'-'+fontSize);
    await click('document.querySelector("[aria-label=关闭目录]")');await sleep(200);
    await open('打开书签与备注','.reader-marks-panel');
    const marks=await evaluate(`(()=>{const p=document.querySelector('.reader-marks-panel'),heading=p.querySelector('.reader-panel-heading'),range=document.createRange();range.selectNodeContents(heading.querySelector('h2'));return{width:p.clientWidth,scroll:p.scrollWidth,top:p.getBoundingClientRect().top,bottom:p.getBoundingClientRect().bottom,headingHeight:heading.getBoundingClientRect().height,titleLines:range.getClientRects().length}})()`);
    await screenshot('reader-navigation-marks-'+width+'-'+fontSize);
    let markActions;
    if(width>=390){
      await wait(`document.querySelector('[aria-label=刷新书签与备注]').getAttribute('aria-busy')==='false'`);
      await evaluate('resumeFixture.holdMarks.load=true');
      await click('document.querySelector("[aria-label=刷新书签与备注]")');await wait('resumeFixture.pendingMarks.some(r=>r.operation==="load")');
      const refreshing=await snapshot();
      await evaluate('resumeFixture.holdMarks.load=false;resumeFixture.pendingMarks.splice(0).forEach(r=>r.resolve())');
      await wait(`document.querySelector('[aria-label=刷新书签与备注]').getAttribute('aria-busy')==='false'`);await sleep(100);
      const refreshed=await snapshot();
      await replace('[aria-label="阅读备注"]','异步保存的备注');
      await evaluate('resumeFixture.holdMarks.create=true');
      await activate(`Array.from(document.querySelectorAll('.reader-mark-save-actions button')).find(e=>e.textContent.includes('存备注'))`);
      await wait('resumeFixture.pendingMarks.some(r=>r.operation==="create")');
      const saving=await snapshot();
      await evaluate('resumeFixture.holdMarks.create=false;resumeFixture.pendingMarks.splice(0).forEach(r=>r.resolve())');
      await wait('document.querySelector(".reader-mark-compose [role=status]")?.textContent.includes("备注已保存")');await sleep(100);
      const saved=await snapshot();
      markActions={refreshing,refreshed,saving,saved};
    }
    await click('document.querySelector("[aria-label=关闭书签与备注]")');await sleep(200);
    observations.push({width,height,touch,fontSize,theme,before,empty,found,next,missing,resultLines,closed,toc,marks,markActions});
    console.log('OBSERVED navigation UI',width,fontSize,JSON.stringify(observations.at(-1)));
    if(!baseline){
      ensure(toc.scroll<=toc.width+1&&marks.scroll<=marks.width+1,width+' navigation panels fit their width');
      ensure(Math.abs(empty.scroll-before.scroll)<=1,width+' opening an empty search preserves reading position');
      ensure(found.mark.top>=found.find.bottom-1&&found.mark.bottom<=found.footer.top+1,width+' active match is visible between search and reading controls');
      ensure(found.result==='1/160'&&next.result==='2/160'&&missing.result==='未找到匹配',width+' search matches, navigation and empty result are accurate');
      ensure(closed.focus==='打开当前章查找',width+' closing search restores its opener');
      ensure(marks.headingHeight<Math.min(240,(marks.bottom-marks.top)/2),width+' mark heading leaves usable room for notes');
      if(markActions){
        ensure(markActions.refreshing.focus==='刷新书签与备注'&&markActions.refreshed.focus==='刷新书签与备注',width+' refreshing retains focus through its asynchronous result');
        ensure(markActions.saving.focus==='BUTTON'&&markActions.saved.focus==='BUTTON',width+' saving retains focus while busy and after the draft clears');
      }
      ensure(resultLines===1,width+' empty search feedback stays horizontal');
    }
    await evaluate("document.documentElement.style.fontSize=''");
  }
  if(!baseline)await verifyMarkFocusTransitions({ command, ensure, evaluate, fresh, wait, click, reveal, sleep });
  fs.writeFileSync(path.join(reportDir,baseline?'navigation-ui-baseline.json':'navigation-ui-observations.json'),JSON.stringify({observations},null,2));
}
