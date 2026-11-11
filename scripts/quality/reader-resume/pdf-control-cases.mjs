import fs from 'node:fs';
import path from 'node:path';

export async function verifyPdfSelection({ command, ensure, evaluate, fresh, wait, click, sleep }) {
  await fresh(1536, 864, false, 'pdf&pdfPages=3', false);
  const layer = `document.querySelector('[data-pdf-page="1"] .pdf-text-layer')`;
  await wait(`${layer}?.textContent.includes('Reading page 1, line 2.')`);
  ensure(await evaluate(`getComputedStyle(${layer}.querySelector('span'),'::selection').color==='rgba(0, 0, 0, 0)'`),'PDF selection highlights the bitmap without drawing duplicate text');
  for (const zoom of [false, true]) {
    if (zoom) {
      await evaluate('getSelection().removeAllRanges()');
      await click(`document.querySelector('[aria-label="放大"]')`);
      await sleep(400);
      await wait(`${layer}?.textContent.includes('Reading page 1, line 2.')`);
    }
    const before = await evaluate(`({top:document.querySelector('.pdf-reader-scroll').scrollTop,visible:!document.querySelector('.pdf-reader-toolbar').inert})`);
    const points = await evaluate(`(()=>{
      const spans=[...${layer}.querySelectorAll('span')];
      const a=spans.find(e=>e.textContent.startsWith('Reading page 1, line 1.'));
      const b=spans.find(e=>e.textContent.startsWith('Reading page 1, line 2.'));
      const r1=a.getBoundingClientRect(),r2=b.getBoundingClientRect();
      return {start:{x:r1.left+0.5,y:r1.top+r1.height/2},end:{x:r2.right-0.5,y:r2.top+r2.height/2},expected:a.textContent+' '+b.textContent};
    })()`);
    await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...points.start});
    for(let i=1;i<=8;i++) await command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:points.start.x+(points.end.x-points.start.x)*i/8,y:points.start.y+(points.end.y-points.start.y)*i/8});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...points.end});
    const selected = await evaluate(`getSelection().toString().replace(/\\s+/g,' ').trim()`);
    ensure(selected===points.expected,'PDF mouse drag selects consecutive lines'+(zoom?' after zoom':''),{selected,expected:points.expected});
    ensure(await evaluate(`Math.abs(document.querySelector('.pdf-reader-scroll').scrollTop-${before.top})<1&&(!document.querySelector('.pdf-reader-toolbar').inert)===${before.visible}`),'PDF selection keeps scroll and controls unchanged');
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
    await evaluate(`(()=>{const box=document.createElement('textarea');box.id='copy-test';box.style='position:fixed;top:0;left:0;z-index:9999';document.body.append(box);box.focus()})()`);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2});
    await sleep(100);
    ensure(await evaluate(`document.querySelector('#copy-test').value.replace(/\\s+/g,' ').trim()`)===selected,'PDF Ctrl+C copies selected text for pasting');
    await evaluate(`document.querySelector('#copy-test').remove()`);
  }
}

export async function verifyPdfAppearance({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot }) {
  const control = label => `document.querySelector('[aria-label="${label}"]')`;
  const canvas = `document.querySelector('[data-pdf-page="2"] canvas')`;
  const scroll = `document.querySelector('.pdf-reader-scroll')`;
  for (const [width, height, touch, scan] of [[1536,864,false,false],[768,1024,true,true],[390,844,true,false]].filter(item => !process.env.READER_PDF_TEST_WIDTH || item[0] === Number(process.env.READER_PDF_TEST_WIDTH))) {
    await fresh(width, height, touch, 'pdf&pdfPages=3&initialPage=2&persistPreferences'+(scan?'&pdfScan':''), false);
    await wait(`${control('当前页码')}?.value==='2'&&!!document.querySelector('[data-pdf-page="2"] canvas,[data-pdf-page="2"] .pdf-reflow-text')`);
    if (touch && !scan) await click(control('切换到原页模式'));
    await wait(`!!${canvas}&&${canvas}.width>0`); await sleep(400);
    await evaluate(`window.pdfAppearanceCanvas=${canvas};window.pdfAppearancePixels=${canvas}.toDataURL()`);
    await click(control('打开阅读设置')); await wait(`!!${control('PDF 纸面亮度')}`);
    ensure(await evaluate(`!document.querySelector('.reader-font-stepper')&&!document.querySelector('.reader-settings-panel [aria-label="净白"]')`),width+' PDF settings show page appearance instead of text typography');
    const top = await evaluate(`${scroll}.scrollTop`);
    const filters = [];
    for (const theme of ['纸书','护眼','原色','夜间']) {
      await click(`document.querySelector('.reader-settings-panel [aria-label="${theme}"]')`);
      filters.push(await evaluate(`getComputedStyle(${canvas}).filter`));
      ensure(await evaluate(`${canvas}===pdfAppearanceCanvas&&${canvas}.toDataURL()===pdfAppearancePixels&&Math.abs(${scroll}.scrollTop-${top})<1`),width+' PDF '+theme+' changes display without replacing the bitmap or moving the page');
    }
    ensure(new Set(filters).size===4,width+' PDF themes apply distinct appearances to original pages and scanned fallbacks',filters);
    const nightPixels = await evaluate(`(()=>{
      const source=document.createElement('canvas'),output=document.createElement('canvas');source.width=output.width=5;source.height=output.height=1;
      const input=source.getContext('2d'),result=output.getContext('2d');
      ['#000000','#808080','#ffffff','#ff0000','#0000ff'].forEach((color,index)=>{input.fillStyle=color;input.fillRect(index,0,1,1)});
      result.filter=getComputedStyle(${canvas}).filter;result.drawImage(source,0,0);
      const data=result.getImageData(0,0,5,1).data;return Array.from({length:5},(_,i)=>Array.from(data.slice(i*4,i*4+3)));
    })()`);
    ensure(nightPixels[0][0]<nightPixels[1][0]&&nightPixels[1][0]<nightPixels[2][0]&&nightPixels[2][0]<200
      &&nightPixels[3][0]>nightPixels[3][1]&&nightPixels[3][0]>nightPixels[3][2]
      &&nightPixels[4][2]>nightPixels[4][0]&&nightPixels[4][2]>nightPixels[4][1],width+' PDF night mode dims white while preserving grayscale order and illustration colors',nightPixels);
    await evaluate(`${control('PDF 纸面亮度')}.focus()`);
    for (let step=0;step<5;step++) {
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
      await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
    }
    await sleep(100);
    ensure(await evaluate(`JSON.parse(localStorage.getItem('aisu-bookhouse:reader-preferences')).pdfBrightness===75&&getComputedStyle(${canvas}).filter.includes('brightness(0.75)')&&Math.abs(${scroll}.scrollTop-${top})<1`),width+' PDF brightness responds to the slider and saves without moving the page');
    await screenshot('pdf-appearance-'+width+'-settings');
    await click(control('关闭阅读设置')); await sleep(200); await screenshot('pdf-appearance-'+width+'-night');
    await command('Page.reload');
    await wait(`!!document.querySelector('.pdf-reader-scroll canvas,.pdf-reflow-text')`);
    if (touch && !scan) await click(control('切换到原页模式'));
    const reopenedCanvas = `document.querySelector('.pdf-reader-scroll canvas')`;
    await wait(`!!${reopenedCanvas}&&${reopenedCanvas}.width>0`);
    ensure(await evaluate(`document.querySelector('.pdf-reader-shell').classList.contains('reader-theme-dark')&&getComputedStyle(${reopenedCanvas}).filter.includes('brightness(0.75)')`),width+' PDF night theme and brightness survive reopening');
  }
}

export async function verifyPdfMiddleScroll({ command, ensure, evaluate, fresh, wait, click, sleep }) {
  const scroll = `document.querySelector('.pdf-reader-scroll')`;
  const snapshot = () => evaluate(`({top:${scroll}.scrollTop,page:Number(document.querySelector('[aria-label="当前页码"]').value),visible:!document.querySelector('.pdf-reader-toolbar').inert})`);
  for (const mode of ['page', 'text']) {
    await fresh(1536, 864, false, 'pdf&pdfPages=64&initialPage=50', false);
    await wait(`document.querySelector('[aria-label="当前页码"]')?.value==='50'&&!!document.querySelector('[data-pdf-page="50"] canvas')`);
    if (mode === 'text') {
      await click(`Array.from(document.querySelectorAll('.pdf-reader-toolbar button')).find(e=>e.textContent==='文本')`);
      await wait(`!!document.querySelector('[data-pdf-page="50"] .pdf-reflow-text')`);
    }
    await sleep(400);
    const point = await evaluate(`(()=>{const r=${scroll}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const before = await snapshot();
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'middle', buttons: 4, clickCount: 1, ...point });
    // Native autoscroll changes scrollTop without wheel events, even while the
    // pointer stays still. Feed that scroll path after a real middle press.
    const target = await evaluate(`(()=>{const s=${scroll},p=s.querySelector('[data-pdf-page="52"]');s.scrollTop+=p.getBoundingClientRect().top-s.getBoundingClientRect().top+120;return s.scrollTop})()`);
    await sleep(700);
    const held = await snapshot();
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'middle', clickCount: 1, ...point });
    const after = await snapshot();
    ensure(Math.abs(held.top-target)<2&&Math.abs(after.top-held.top)<2&&held.page>=51&&before.visible===after.visible,
      'PDF '+mode+' middle-button scroll releases the restored page without snapping back or toggling controls', { before, target, held, after });
  }
}

export async function verifyPdfControls({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot, baseline, reportDir }) {
  if (!baseline) await verifyPdfMiddleScroll({ command, ensure, evaluate, fresh, wait, click, sleep });
  if (!baseline) await verifyPdfAppearance({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot });
  const observations = [];
  const control = label => `document.querySelector('[aria-label="${label}"]')`;
  const key = async value => {
    const code = value === 'Escape' ? 27 : 13;
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: code, text: value === 'Enter' ? '\r' : undefined });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode: code }); await sleep(150);
  };
  const hit = expression => evaluate(`(()=>{const e=${expression};if(!e)return false;const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
  const activate = async label => {
    const expression = control(label);
    await evaluate(`${expression}.scrollIntoView({block:'nearest',inline:'nearest'})`); await sleep(50);
    if (!await hit(expression)) throw Error('PDF control is covered: ' + label);
    await click(expression); await sleep(90);
  };
  const tapCenter = async touch => {
    const point = await evaluate(`(()=>{const r=document.querySelector('.pdf-reader-scroll').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (touch) {
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    }
    await sleep(700);
  };
  const snapshot = () => evaluate(`(()=>{
    const toolbar=document.querySelector('.pdf-reader-toolbar'),sidebar=document.querySelector('.pdf-reader-sidebar'),s=document.querySelector('.pdf-reader-scroll'),current=Number(document.querySelector('[aria-label="当前页码"]').value),item=sidebar?.querySelector('[data-pdf-thumbnail-page="'+current+'"]'),list=sidebar?.querySelector('.pdf-thumbnail-list')||sidebar;
    const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};
    const controls=[...toolbar.querySelectorAll('button,input')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return{label:e.getAttribute('aria-label')||e.textContent,rect:rect(e),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}});
    return{current,scroll:s.scrollTop,content:rect(s),frame:rect(s.querySelector('[data-pdf-page="'+current+'"]')),toolbar:rect(toolbar),toolbarWidth:toolbar.clientWidth,toolbarScrollWidth:toolbar.scrollWidth,visible:!toolbar.inert,clip:s.parentElement.style.clipPath,controls,status:rect(document.querySelector('.pdf-reading-status')),percent:rect(document.querySelector('.pdf-reading-status [aria-label="阅读进度"]')),sidebar:rect(sidebar),list:rect(list),item:rect(item),marker:item?.getAttribute('aria-current'),sidebarScroll:list?.scrollTop,focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName};
  })()`);
  const layouts = [[1536,864,false,16],[768,1024,true,16],[390,844,true,16],[844,390,true,16],[320,640,true,32],[320,280,true,32]];
  if(!baseline)layouts.push([390,844,true,16,'page'],[844,390,true,16,'scan']);
  for (const [width,height,touch,fontSize,mode='default'] of layouts.filter(item => !process.env.READER_PDF_TEST_WIDTH || item[0] === Number(process.env.READER_PDF_TEST_WIDTH))) {
    const label = `${width}x${height} ${fontSize}px PDF ${mode}`;
    await fresh(width,height,touch,'pdf&pdfPages=64&initialPage=50'+(mode==='scan'?'&pdfScan':''),false);
    await wait(`document.querySelector('[aria-label="当前页码"]')?.value==='50' && !!document.querySelector('[data-pdf-page="50"] canvas,[data-pdf-page="50"] .pdf-reflow-text')`);
    await evaluate(`document.documentElement.style.fontSize='${fontSize}px'`); await sleep(350);
    if (await evaluate("document.querySelector('.pdf-reader-toolbar').inert")) await tapCenter(touch);
    if(mode==='page'){await activate('切换到原页模式');await wait(`!document.querySelector('.pdf-reader-scroll').classList.contains('pdf-text-scroll')&&!!document.querySelector('[data-pdf-page="50"] canvas')`);await sleep(200);}
    const initial = await snapshot(); await screenshot(`pdf-controls-${width}-${height}-${fontSize}-${mode}${baseline?'-baseline':''}`);
    await activate('切换缩略图'); await wait('!!document.querySelector(".pdf-reader-sidebar")'); await sleep(250);
    const sidebar = await snapshot(); await screenshot(`pdf-sidebar-${width}-${height}-${fontSize}-${mode}${baseline?'-baseline':''}`);
    if(!baseline&&touch){
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await sleep(60);
      ensure(await evaluate(`!!document.activeElement?.closest('.pdf-reader-sidebar')`),label+' keyboard focus remains inside the touch directory');
    }
    await key('Escape'); const closed = await snapshot();
    if (closed.sidebar) await activate('切换缩略图');
    if (!baseline) {
      ensure(initial.current===50&&initial.toolbarScrollWidth<=initial.toolbarWidth+1&&initial.controls.every(c=>c.hit&&c.rect.left>=-1&&c.rect.right<=width+1&&c.rect.height>=44),label+' all toolbar controls fit and remain reachable with enlarged text',initial);
      ensure(initial.content.top>=initial.toolbar.bottom-1,label+' the toolbar stays outside the scrollable reading surface',initial);
      ensure(initial.percent.top>=initial.status.top-1&&initial.percent.bottom<=height+1&&initial.percent.right<=width+1,label+' the progress percentage remains fully visible with enlarged text',initial);
      ensure(sidebar.marker==='page'&&sidebar.list.bottom<=sidebar.sidebar.bottom+1&&sidebar.item.top>=Math.max(sidebar.list.top,sidebar.sidebar.top)-1&&sidebar.item.bottom<=Math.min(sidebar.list.bottom,sidebar.sidebar.bottom)+1,label+' thumbnails open on the visible current page',sidebar);
      ensure(!closed.sidebar&&closed.focus==='切换缩略图'&&closed.current===50,label+' Escape returns to the thumbnail opener without changing pages',closed);
    }
    if (await evaluate("document.querySelector('.pdf-reader-toolbar').inert")) await tapCenter(touch);
    const toolsReachable = !touch || await hit(control('更多阅读工具'));
    const item = {label,initial,sidebar,closed,toolsReachable};
    if (toolsReachable) {
      if (touch) await activate('更多阅读工具');
      let zoomOut = await evaluate(`document.querySelector('[aria-label="减小字号"]')?'减小字号':'缩小'`);
      for (let step=0;step<20;step++) {
        if (await evaluate(`${control(zoomOut)}.disabled||${control(zoomOut)}.getAttribute('aria-disabled')==='true'`)) break;
        await activate(zoomOut);
      }
      const minimum = await evaluate(`({focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName,label:${control(zoomOut)}.getAttribute('aria-label'),disabled:${control(zoomOut)}.getAttribute('aria-disabled')==='true',text:document.querySelector('[title="适合整页"],[title="恢复默认字号"],[title="恢复页面大小"],[title="恢复适合宽度"]').textContent})`);
      await key('Enter'); const minimumRepeat = await evaluate(`({focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName,text:document.querySelector('[title="适合整页"],[title="恢复默认字号"],[title="恢复页面大小"],[title="恢复适合宽度"]').textContent})`);
      Object.assign(item,{minimum,minimumRepeat});
      if (!baseline) {
        const zoomIn=zoomOut==='减小字号'?'增大字号':'放大';
        for(let step=0;step<100;step++){
          if(await evaluate(`${control(zoomIn)}.getAttribute('aria-disabled')==='true'`))break;
          await activate(zoomIn);
        }
        const resetSelector='[title="适合整页"],[title="恢复默认字号"],[title="恢复页面大小"],[title="恢复适合宽度"]';
        const maximum=await evaluate(`({focus:document.activeElement?.getAttribute('aria-label'),disabled:${control(zoomIn)}.getAttribute('aria-disabled')==='true',text:document.querySelector('${resetSelector}').textContent})`);
        await key('Enter');
        ensure(maximum.focus===zoomIn&&maximum.disabled&&(zoomIn!=='增大字号'||maximum.text==='26px')&&await evaluate(`document.activeElement===${control(zoomIn)}&&document.querySelector('${resetSelector}').textContent===${JSON.stringify(maximum.text)}`),label+' maximum zoom or font size keeps focus without exceeding its limit',maximum);
        await activate(await evaluate(`document.querySelector('${resetSelector}').getAttribute('aria-label')`));
      }
      if (touch) { await key('Escape'); item.toolsClosed=await evaluate(`!document.querySelector('[aria-label="更多阅读工具"][role="dialog"]')&&document.activeElement?.getAttribute('aria-label')==='更多阅读工具'`); }
      if (!baseline) {
        ensure(minimum.disabled&&minimum.focus===zoomOut&&minimumRepeat.focus===zoomOut&&minimumRepeat.text===minimum.text,label+' zoom or font minimum retains focus and rejects repeated activation',{minimum,minimumRepeat});
        if (touch) ensure(item.toolsClosed,label+' tools dismissal returns focus to a usable opener');
      }
    }
    if(!baseline){
      if(touch){
        await evaluate(`window.pdfTouchTrace=[];['pointerdown','pointerup','touchstart','touchend','mousedown','focusin','focusout','click'].forEach(type=>document.addEventListener(type,event=>{pdfTouchTrace.push({type,at:performance.now(),target:event.target.getAttribute?.('aria-label')||event.target.className,focus:document.activeElement?.getAttribute('aria-label'),visible:!document.querySelector('.pdf-reader-toolbar').inert,selection:!!getSelection()?.toString()})},true));true`);
        const paint=`(()=>{const h=document.querySelector('.pdf-reader-toolbar'),s=document.querySelector('.pdf-reader-scroll'),r=s.getBoundingClientRect();return{opacity:Number(getComputedStyle(h).opacity),clip:s.parentElement.style.clipPath,scroll:s.scrollTop,top:r.top,bottom:r.bottom}})()`;
        const before=await evaluate(paint);
        for(const direction of [-1,1]){
          await evaluate(`window.pdfPaint=[];window.pdfPaintDone=new Promise(resolve=>{const start=performance.now();const sample=()=>{pdfPaint.push(${paint});if(performance.now()-start<600)requestAnimationFrame(sample);else resolve(pdfPaint)};sample()});true`);
          await tapCenter(touch);const frames=await evaluate('pdfPaintDone');
          ensure(frames.at(-1).opacity===(direction<0?0:1)&&frames.every((frame,i)=>frame.clip===''&&Math.abs(frame.scroll-before.scroll)<1&&frame.top===before.top&&frame.bottom===before.bottom&&(!i||(frame.opacity-frames[i-1].opacity)*direction>=-.001)),label+' toolbar '+(direction<0?'dismissal':'reveal')+' fades without clipping or moving the reading surface',{frames,trace:await evaluate('pdfTouchTrace')});
        }
      }
      await activate('切换缩略图');await wait('!!document.querySelector(".pdf-reader-sidebar")');await activate('第 51 页');
      await wait(`document.querySelector('[aria-label="当前页码"]').value==='51'`);await sleep(550);
      const selected=await snapshot();
      ensure(selected.current===51&&selected.frame.top>=selected.content.top-1&&selected.frame.top<selected.content.top+100&&(!touch||!selected.sidebar),label+' selecting a thumbnail displays that page and dismisses the touch directory',selected);
      if(selected.sidebar)await key('Escape');
      await evaluate(`${control('当前页码')}.focus();${control('当前页码')}.select()`);await command('Input.insertText',{text:'６４'});await key('Enter');
      await wait(`document.querySelector('[aria-label="当前页码"]').value==='64'&&!!document.querySelector('[data-pdf-page="64"] canvas,[data-pdf-page="64"] .pdf-reflow-text')`);await sleep(350);
      for(let step=0;step<3;step++){await evaluate("document.querySelector('.pdf-reader-scroll').scrollTop=1e8");await sleep(180);}
      await wait(`document.querySelector('.pdf-reading-status [aria-label="阅读进度"]').textContent==='100%'`);
      ensure(true,label+' full-width page entry reaches the last page and reading its end reports 100 percent');
    }
    observations.push(item);console.log('PDF_CONTROLS_OBSERVED',JSON.stringify(item));
    await evaluate("document.documentElement.style.fontSize=''");
  }
  fs.writeFileSync(path.join(reportDir,baseline?'pdf-controls-baseline.json':'pdf-controls-observations.json'),JSON.stringify({observations},null,2));
}
