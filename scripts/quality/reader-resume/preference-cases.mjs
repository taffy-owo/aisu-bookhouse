import fs from 'node:fs';
import path from 'node:path';

export async function verifyReaderPreferences({ command, ensure, evaluate, fresh, ready, wait, click, reveal, readAt, back, reopen, sleep, screenshot, baseline, reportDir, layoutOnly = false }) {
  const observations = [];
  const button = text => `Array.from(document.querySelectorAll('.reader-settings-panel button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const fontButton = direction => `document.querySelector('.reader-settings-panel [aria-label="${direction === 1 ? '增大' : '减小'}字号"]')`;
  const groupButton = (group, text) => `Array.from(Array.from(document.querySelectorAll('.reader-setting-group')).find(e=>e.querySelector('.reader-setting-muted span')?.textContent===${JSON.stringify(group)}).querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const activate = async expression => {
    await evaluate(`(${expression}).scrollIntoView({block:'nearest'})`);
    await click(expression);
  };
  const open = async () => {
    await reveal('[aria-label=打开阅读设置]');
    await click('document.querySelector("[aria-label=打开阅读设置]")');
    await wait('!!document.querySelector(".reader-settings-panel")');
    await sleep(400);
  };
  const prefs = () => evaluate('JSON.parse(localStorage.getItem("aisu-bookhouse:reader-preferences"))');
  const press = async (key, code, windowsVirtualKeyCode) => {
    await command('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});
    await sleep(60);
  };
  const verifyLimits = async (label, pdf = false) => {
    const field = pdf ? 'pdfTextFontSize' : 'fontScale', maximum = pdf ? 26 : 'large', minimum = pdf ? 16 : 'small';
    for(let i=0;i<6 && (await prefs())[field]!==maximum;i++) await activate(fontButton(1));
    ensure(await evaluate(`document.activeElement===${fontButton(1)} && ${fontButton(1)}.getAttribute('aria-disabled')==='true'`),label+' reaching maximum keeps focus and communicates the limit');
    await activate(fontButton(1)); await press('Enter','Enter',13); await press(' ','Space',32);
    ensure((await prefs())[field]===maximum,label+' repeated mouse and keyboard actions cannot exceed the maximum');
    ensure(await evaluate(`document.querySelector('.reader-font-stepper [role="status"]')?.textContent===${JSON.stringify(pdf?'26px':'大号')}`),label+' current size is available as an announced status');
    await press('Tab','Tab',9);
    ensure(await evaluate('document.activeElement===document.querySelector(".reader-settings-panel [aria-label=纸书]")'),label+' Tab continues to the next setting after the maximum');
    for(let i=0;i<6 && (await prefs())[field]!==minimum;i++) await activate(fontButton(-1));
    ensure(await evaluate(`document.activeElement===${fontButton(-1)} && ${fontButton(-1)}.getAttribute('aria-disabled')==='true'`),label+' reaching minimum keeps focus and communicates the limit');
    await activate(fontButton(-1)); await press('Enter','Enter',13); await press(' ','Space',32);
    ensure((await prefs())[field]===minimum,label+' repeated mouse and keyboard actions cannot go below the minimum');
    await press('Tab','Tab',9);
    ensure(await evaluate(`document.activeElement===${fontButton(1)}`),label+' Tab continues to increase after the minimum');
  };
  const anchor = () => evaluate(`(()=>{const shell=document.querySelector('.reader-viewport'),s=document.querySelector('.reader-document-scroll')?document.scrollingElement:shell;const y=s===document.scrollingElement?80:s.getBoundingClientRect().top+80;const p=[...document.querySelectorAll('.reader-body-text p')].find(p=>p.getBoundingClientRect().bottom>y);return{text:p?.textContent,top:p?.getBoundingClientRect().top,scroll:s.scrollTop}})()`);
  for (const [width,height,touch] of (layoutOnly ? [] : [[1536,864,false],[768,1024,true],[390,844,true]])) {
    await fresh(width,height,touch,'persistPreferences&theme=dark');
    await readAt(4000);
    const before = await anchor();
    await open();
    await activate('document.querySelector("[aria-label=增大字号]")');
    const fontFocus = await evaluate('document.activeElement?.outerHTML.slice(0,250)');
    if (!baseline) {
      await verifyLimits(width+' novel');
      await activate(fontButton(1)); await activate(fontButton(1));
      for(const [text,value] of [['纸书','paper'],['净白','white'],['护眼','green'],['夜间','dark']]) {
        await activate(`document.querySelector('.reader-settings-panel [aria-label="${text}"]')`);
        ensure((await prefs()).theme===value && await evaluate(`document.querySelector('.reader-settings-panel [aria-label="${text}"]').getAttribute('aria-pressed')==='true' && !!document.querySelector('.reader-with-reading-status.reader-theme-${value}')`),width+' theme '+value+' applies and shows selection');
      }
      for(const [text,value] of [['黑体','sans'],['书宋','song'],['文楷','wenkai'],['思源宋','serif']]) {
        await activate(groupButton('字体',text));
        ensure((await prefs()).fontFamily===value,width+' font '+value+' selection is saved');
      }
    }
    await activate(button('高级排版'));
    if (!baseline) {
      await activate(groupButton('阅读密度','紧凑'));
      const compact=await prefs();
      ensure(compact.lineHeight==='compact'&&compact.pagePadding==='compact'&&compact.paragraphSpacing==='tight'&&compact.fontScale==='large'&&compact.theme==='dark',width+' density preset changes only layout fields');
      await activate(groupButton('栏宽','宽栏'));
      ensure(await evaluate('document.querySelector(".reader-settings-advanced").textContent.includes("自定义排版")'),width+' individual adjustments are shown as custom layout');
    }
    await activate(button('宽松'));
    await activate(button('完成'));
    await wait('!document.querySelector(".reader-settings-panel")');
    await sleep(500);
    const after = await anchor(), saved = await prefs();
    await screenshot('reader-preferences-'+width);
    await back(); await reopen();
    const reopened = await prefs(), reopenAnchor = await anchor();
    await command('Page.reload'); await ready(1); await sleep(500);
    const reloaded = await prefs(), reloadAnchor = await anchor();
    await open();
    await activate(button('恢复默认'));
    const reset = await prefs();
    await activate(button('完成')); await sleep(450);
    const resetAnchor = await anchor();
    observations.push({width,touch,before,after,fontFocus,saved,reopened,reopenAnchor,reloaded,reloadAnchor,reset,resetAnchor});
    console.log('CHECKED preference lifecycle',width);
    if (!baseline) {
      ensure(saved.fontScale==='large' && saved.lineHeight==='loose',width+' font and layout selections apply');
      ensure(after.text===before.text,width+' typography changes preserve the visible paragraph',{before,after});
      ensure(JSON.stringify(reopened)===JSON.stringify(saved) && JSON.stringify(reloaded)===JSON.stringify(saved),width+' preferences persist across exit and full reload');
      ensure(reopenAnchor.text===after.text && Math.abs(reopenAnchor.scroll-after.scroll)<=2 && reloadAnchor.text===after.text && Math.abs(reloadAnchor.scroll-after.scroll)<=2,width+' reopening and reloading preserve the actual reading position');
      ensure(reset.fontScale==='medium' && reset.theme==='paper' && reset.lineHeight==='comfortable',width+' restore defaults applies the default reading appearance');
      ensure(resetAnchor.text===after.text,width+' restoring default typography preserves the reading paragraph');
      await open(); await activate(button('操作'));
      const hasTouchSetting=await evaluate('matchMedia("(any-pointer: coarse)").matches');
      ensure(await evaluate(`!!document.querySelector('.reader-setting-group:has([aria-pressed])') && ${hasTouchSetting}===document.querySelector('.reader-settings-fields').textContent.includes('轻点翻页')`),width+' operation settings match reported input capabilities');
      await activate(groupButton('翻阅方式','左右翻页'));
      if(hasTouchSetting) await activate(groupButton('轻点翻页','关闭'));
      await activate(button('完成')); await sleep(350);
      await command('Page.reload'); await ready(1);
      ensure((await prefs()).readingMode==='paged' && (!hasTouchSetting||(await prefs()).tapToTurnPage===false),width+' reading mode and touch setting persist after reload');
      await open(); await activate(button('恢复默认'));
      ensure((await prefs()).readingMode==='scroll' && (await prefs()).tapToTurnPage===true,width+' defaults restore scroll mode and touch navigation');
      await press('Escape','Escape',27);
      await wait('!document.querySelector(".reader-settings-panel")');
    }
  }
  for (const [width,height,fontSize] of [[320,640,32],[844,390,16]]) {
    await fresh(width,height,true,'persistPreferences&theme=paper');
    await evaluate(`document.documentElement.style.fontSize='${fontSize}px'`);
    await open();
    await activate(button('高级排版'));
    await activate(groupButton('字体','思源宋'));
    const layout = await evaluate(`(()=>{const panel=document.querySelector('.reader-settings-panel'),fields=panel.querySelector('.reader-settings-fields'),r=fields.getBoundingClientRect();return{width:innerWidth,fontSize:getComputedStyle(document.documentElement).fontSize,client:fields.clientWidth,scroll:fields.scrollWidth,overflow:[...panel.querySelectorAll('button')].filter(e=>e.getBoundingClientRect().left<r.left-1||e.getBoundingClientRect().right>r.right+1).map(e=>({text:e.textContent.trim(),left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})),themeLabels:[...panel.querySelectorAll('.reader-theme-swatch span')].map(e=>{const range=document.createRange();range.selectNodeContents(e);return{text:e.textContent,lines:range.getClientRects().length,fontSize:getComputedStyle(e).fontSize}}),fontLabels:[...panel.querySelectorAll('.reader-setting-group')].find(e=>e.textContent.startsWith('字体')).querySelectorAll('button').values().map(e=>{const range=document.createRange();range.selectNodeContents(e);return{text:e.textContent.trim(),lines:range.getClientRects().length,fontSize:getComputedStyle(e).fontSize}}).toArray(),panel:{top:panel.getBoundingClientRect().top,bottom:panel.getBoundingClientRect().bottom}}})()`);
    observations.push({layout});
    await screenshot('reader-preferences-layout-'+width);
    await evaluate(`document.querySelector('.reader-settings-fields').scrollTop=0`);
    await screenshot('reader-preferences-themes-'+width);
    console.log('CHECKED preference layout',width,JSON.stringify(layout));
    if(!baseline) {
      ensure(layout.scroll<=layout.client+1 && layout.overflow.length===0,width+' setting controls fit without horizontal overflow');
      ensure(layout.themeLabels.every(e=>e.lines===1),width+' theme labels stay horizontal');
      ensure(layout.fontLabels.every(e=>e.lines===1),width+' font labels stay horizontal');
      ensure(layout.fontLabels.every(e=>parseFloat(e.fontSize)>=fontSize*.75),width+' setting choices follow enlarged browser text');
      ensure(layout.panel.top>=-1 && layout.panel.bottom<=height+1,width+' setting panel stays inside the viewport');
    }
    await activate(button('完成'));
    await evaluate("document.documentElement.style.fontSize=''");
  }
  if(!baseline && !layoutOnly) for(const [width,height,touch] of [[1536,864,false],[390,844,true]]) {
    await fresh(width,height,touch,'pdf&persistPreferences&theme=dark',false);
    await wait('!!document.querySelector("[data-pdf-page]")');
    if(!touch) await click(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='文本')`);
    await wait('!!document.querySelector("[aria-label=打开阅读设置]")');
    await click('document.querySelector("[aria-label=打开阅读设置]")');
    await wait('!!document.querySelector(".reader-settings-panel")'); await sleep(400);
    await verifyLimits(width+' PDF',true);
    await activate(button('恢复默认'));
    ensure((await prefs()).pdfTextFontSize===18 && (await prefs()).theme==='paper',width+' PDF defaults reset its displayed appearance');
    await activate(button('完成')); await sleep(200);
    await click('document.querySelector("[aria-label=打开阅读设置]")');
    ensure(await evaluate('document.querySelector(".reader-font-stepper [role=status]")?.textContent==="18px"'),width+' PDF reopening shows its saved size');
    await screenshot('reader-preferences-pdf-'+width);
    await activate(button('完成'));
  }
  fs.writeFileSync(path.join(reportDir,baseline?'preference-baseline.json':layoutOnly?'preference-layout-observations.json':'preference-observations.json'),JSON.stringify({observations},null,2));
  console.log('PREFERENCE_OBSERVATIONS '+JSON.stringify(observations));
}
