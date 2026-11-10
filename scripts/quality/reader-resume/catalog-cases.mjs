import fs from 'node:fs';
import path from 'node:path';

export async function verifyReaderCatalog({ command, ensure, evaluate, fresh, wait, click, reveal, readAt, sleep, screenshot, baseline, reportDir }) {
  const observations = [];
  const opener = 'document.querySelector("[aria-label=打开目录]")';
  const press = async (key, code, windowsVirtualKeyCode) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text: key === 'Enter' ? '\r' : undefined });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    await sleep(90);
  };
  const replace = async (selector, text) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);
    if (text) await command('Input.insertText', { text });
    else await press('Backspace', 'Backspace', 8);
    await sleep(180);
  };
  const open = async selector => {
    await reveal('[aria-label=打开目录]');
    await evaluate(`${opener}.scrollIntoView({block:'nearest',inline:'nearest'})`);
    await sleep(80);
    const target = await evaluate(`(()=>{const e=${opener},r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{clickable:!!hit&&e.contains(hit),button:{top:r.top,bottom:r.bottom},hit:hit?.outerHTML.slice(0,200)}})()`);
    if (!target.clickable) throw Error('Catalog opener is covered: '+JSON.stringify(target));
    await click(opener);
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    await sleep(400);
  };
  const mediaSnapshot = () => evaluate(`(()=>{
    const panel=document.querySelector('[aria-label="页目录"]'),buttons=[...panel.querySelectorAll('.reader-page-index')],current=buttons.find(e=>e.textContent.trim()==='1738'),list=buttons[0].parentElement.parentElement,close=panel.querySelector('[aria-label="关闭页目录"]');
    const rect=e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};
    const glyphOverflow=buttons.filter(e=>{const range=document.createRange();range.selectNodeContents(e);const r=range.getBoundingClientRect(),b=e.getBoundingClientRect();return r.left<b.left-1||r.right>b.right+1}).length;
    return{panel:rect(panel),width:panel.clientWidth,scrollWidth:panel.scrollWidth,current:rect(current),currentMarker:current.getAttribute('aria-current'),list:rect(list),listScroll:list.scrollTop,close:rect(close),glyphOverflow,focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName};
  })()`);
  const readingAnchor = () => evaluate(`(()=>{const line=[...document.querySelectorAll('.reader-body-text p')].find(p=>p.getBoundingClientRect().bottom>Math.min(160,innerHeight/2));return{text:line?.textContent,top:line?.getBoundingClientRect().top}})()`);
  const tocSnapshot = () => evaluate(`(()=>{
    const panel=document.querySelector('.reader-toc-panel'),list=panel.querySelector('.reader-toc-list'),current=panel.querySelector('[aria-current]');
    const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};
    const scroll=document.querySelector('.reader-document-scroll')?document.scrollingElement:document.querySelector('.reader-viewport');
    return{panel:rect(panel),width:panel.clientWidth,scrollWidth:panel.scrollWidth,list:rect(list),current:rect(current),listScroll:list.scrollTop,readerScroll:scroll.scrollTop,count:panel.querySelectorAll('.reader-toc-item').length};
  })()`);
  for (const [width,height,touch,fontSize] of [[1536,864,false,16],[768,1024,true,16],[390,844,true,16],[320,640,true,32],[844,390,true,16],[320,280,true,32]].filter(([,h])=>!process.env.READER_CATALOG_HEIGHT||h===Number(process.env.READER_CATALOG_HEIGHT))) {
    const label=`${width}x${height} ${fontSize}px media catalog`;
    await fresh(width,height,touch,'readableManga&mediaPageCount=2345&initialPage=1738',false);
    await wait('!!document.querySelector(".reader-mobile-pan img") && document.body.innerText.includes("第 1738 页")');
    await evaluate(`document.documentElement.style.fontSize='${fontSize}px'`);
    await sleep(200);await open('[aria-label="页目录"]');
    const initial=await mediaSnapshot();console.log("CATALOG_INITIAL",label,JSON.stringify(initial));
    await screenshot(`reader-catalog-media-${width}-${height}-${fontSize}${baseline?'-baseline':''}`);
    await replace('[aria-label="输入页码"]','1e2');await press('Enter','Enter',13);
    const invalid=await evaluate('!!document.querySelector("[aria-label=页目录]") && document.querySelector("[aria-label=页目录] button[type=submit]").disabled && resumeFixture.progress().image_index===1738');
    await replace('[aria-label="输入页码"]','１７３９');await press('Enter','Enter',13);
    await wait('!document.querySelector("[aria-label=页目录]") && document.body.innerText.includes("第 1739 页")');
    await open('[aria-label="页目录"]');await replace('[aria-label="输入页码"]','1739');await press('Escape','Escape',27);
    const closed=await evaluate('({closed:!document.querySelector("[aria-label=页目录]"),focus:document.activeElement?.getAttribute("aria-label"),inert:!!document.activeElement?.closest("[inert]")})');
    observations.push({label,initial,invalid,closed});console.log('CATALOG_OBSERVED',JSON.stringify(observations.at(-1)));
    if (!baseline) {
      ensure(initial.list.bottom<=initial.panel.bottom+1&&initial.list.height>=44&&initial.current.top>=Math.max(initial.panel.top,initial.list.top)-1&&initial.current.bottom<=Math.min(initial.panel.bottom,initial.list.bottom)+1,label+' opens with the current page visible');
      ensure(initial.currentMarker==='page',label+' identifies the current page for assistive reading');
      ensure(initial.scrollWidth<=initial.width+1&&initial.glyphOverflow===0,label+' page numbers fit their cells without overlap');
      ensure(initial.close.width>=44&&initial.close.height>=44,label+' close target is at least 44 pixels');
      ensure(invalid,label+' invalid input cannot select an unintended page');
      ensure(closed.closed&&closed.focus==='打开目录'&&!closed.inert,label+' keyboard dismissal restores a usable directory opener');
    }
    await evaluate("document.documentElement.style.fontSize=''");
  }
  for (const [width,height,touch,fontSize] of [[1536,864,false,16],[768,1024,true,16],[390,844,true,16],[320,640,true,32],[844,390,true,16],[320,280,true,32]].filter(([,h])=>!process.env.READER_CATALOG_HEIGHT||h===Number(process.env.READER_CATALOG_HEIGHT))) {
    const label=`${width}x${height} ${fontSize}px novel catalog`;
    await fresh(width,height,touch,'catalogLength=160&initialChapter=151',false);
    await wait('document.querySelector(".reader-chapter-heading h1")?.textContent==="第151话" && document.querySelector("[data-reader-layout-ready]")?.dataset.readerLayoutReady==="true"');
    await evaluate(`document.documentElement.style.fontSize='${fontSize}px'`);await sleep(200);await readAt(4000);const before=await readingAnchor();
    await open('.reader-toc-panel');const initial=await tocSnapshot();
    await replace('[aria-label="搜索章节或序号"]','１３');const filtered=await tocSnapshot();
    await replace('[aria-label="搜索章节或序号"]','');const cleared=await tocSnapshot();
    await replace('[aria-label="搜索章节或序号"]','不存在的章节');
    const noResult=await evaluate('document.querySelector(".reader-toc-list").textContent.includes("没有匹配的章节")');
    await click('Array.from(document.querySelectorAll(".reader-toc-footer button")).find(e=>e.textContent.includes("定位当前"))');await sleep(160);
    const located=await tocSnapshot();await screenshot(`reader-catalog-novel-${width}-${height}-${fontSize}${baseline?'-baseline':''}`);
    await replace('[aria-label="搜索章节或序号"]','151');await press('Escape','Escape',27);
    const closed=await evaluate('({closed:!document.querySelector(".reader-toc-panel"),focus:document.activeElement?.getAttribute("aria-label"),inert:!!document.activeElement?.closest("[inert]")})');
    await sleep(200);const after=await readingAnchor();
    observations.push({label,before,initial,filtered,cleared,noResult,located,closed,after});console.log('CATALOG_OBSERVED',JSON.stringify(observations.at(-1)));
    if (!baseline) {
      const visible=s=>s.current&&s.current.top>=s.list.top-1&&s.current.bottom<=s.list.bottom+1;
      ensure(visible(initial)&&visible(cleared)&&visible(located),label+' opening, clearing and locating show the current chapter');
      ensure(filtered.count===12&&noResult,label+' full-width chapter queries and empty feedback are accurate');
      ensure(initial.scrollWidth<=initial.width+1&&located.scrollWidth<=located.width+1,label+' long chapter lists remain inside the panel');
      ensure(Math.abs(initial.readerScroll-cleared.readerScroll)<=1&&Math.abs(initial.readerScroll-located.readerScroll)<=1,label+' filtering only scrolls the directory list');
      ensure(closed.closed&&closed.focus==='打开目录'&&!closed.inert,label+' Escape after a search restores a usable directory opener');
      ensure(before.text===after.text&&Math.abs(before.top-after.top)<=1,label+' returning from the catalog preserves the visible paragraph');
    }
    await evaluate("document.documentElement.style.fontSize=''");
  }
  fs.writeFileSync(path.join(reportDir,baseline?'catalog-baseline.json':'catalog-observations.json'),JSON.stringify({observations},null,2));
}
