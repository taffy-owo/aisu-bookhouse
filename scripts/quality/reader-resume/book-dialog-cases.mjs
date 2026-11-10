import fs from 'node:fs';
import path from 'node:path';

export async function verifyBookDialogs({ command, ensure, evaluate, fresh, wait, click, sleep, screenshot, baseline, reportDir }) {
  const observations=[];
  const dialog=`document.querySelector('[role="dialog"]')`;
  const key=async(name,shift=false)=>{
    const codes={Tab:9,Escape:27,Enter:13};
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name,windowsVirtualKeyCode:codes[name],modifiers:shift?8:0});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:name,windowsVirtualKeyCode:codes[name],modifiers:shift?8:0});await sleep(80);
  };
  const pointer=async expression=>{
    await evaluate(`${expression}.scrollIntoView({block:'center',inline:'nearest'})`);await sleep(50);
    const hit=await evaluate(`(()=>{const e=${expression},r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
    if(!hit)throw Error('Covered dialog target '+expression+' '+await evaluate(`(()=>{const e=${expression},r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return JSON.stringify({rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},hit:hit?.outerHTML.slice(0,400),scrollY})})()`));
    await click(expression);
  };
  const open=async kind=>{
    await pointer(`document.querySelector('[aria-label="更多操作"]')`);
    await wait('!!document.querySelector("#book-action-menu")');
    const labels={edit:['编辑资料'],cover:['更换封面'],source:['关联原作','原作资料']}[kind];
    await pointer(`Array.from(document.querySelectorAll('#book-action-menu button')).find(e=>${JSON.stringify(labels)}.includes(e.textContent.trim()))`);
    await wait(`!!${dialog}`);await sleep(150);
  };
  const snapshot=()=>evaluate(`(()=>{
    const d=${dialog},v=d.parentElement,r=d.getBoundingClientRect(),vp=visualViewport;
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    return{dialog:rect(d),viewport:{left:vp?.offsetLeft||0,top:vp?.offsetTop||0,width:vp?.width||innerWidth,height:vp?.height||innerHeight},overflow:d.scrollWidth>d.clientWidth+1,scrollWidth:d.scrollWidth,width:d.clientWidth,portalOverflow:v.scrollWidth>v.clientWidth+1,close:rect(d.querySelector('button')),icons:[...d.querySelectorAll('button svg')].map(rect),fields:[...d.querySelectorAll('input:not([type=file]),select,textarea')].map(e=>({...rect(e),label:e.id||e.closest('label')?.textContent.slice(0,12),font:parseFloat(getComputedStyle(e).fontSize)})),container:getComputedStyle(d).containerName,sourceDirection:d.querySelector('.book-dialog-source-entry')&&getComputedStyle(d.querySelector('.book-dialog-source-entry')).flexDirection,rootFont:getComputedStyle(document.documentElement).fontSize,focusInside:d.contains(document.activeElement),scrollTop:d.scrollTop,maxScroll:d.scrollHeight-d.clientHeight,visualBottom:r.bottom};
  })()`);
  const visible=expression=>evaluate(`(()=>{const e=${expression},r=e.getBoundingClientRect(),vp=visualViewport;return r.left>=(vp?.offsetLeft||0)&&r.right<=(vp?.offsetLeft||0)+(vp?.width||innerWidth)+1&&r.top>=(vp?.offsetTop||0)&&r.bottom<=(vp?.offsetTop||0)+(vp?.height||innerHeight)+1&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
  const cases=[
    [1536,864,false,16,false,1],[390,844,true,16,true,1],[768,1024,true,16,false,1],
    [320,640,true,32,false,1],[844,390,true,32,true,1],[320,280,true,32,true,1],
    [1536,864,false,32,true,1],[1536,864,false,16,false,2],
  ];
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`addEventListener('error',e=>console.error('Book dialog error: '+e.message));addEventListener('unhandledrejection',e=>console.error('Book dialog rejection: '+String(e.reason)));`});
  for(const [width,height,touch,font,dark,scale] of cases)for(const kind of ['edit','cover','source']){
    await command('Emulation.setPageScaleFactor',{pageScaleFactor:1});
    await fresh(width,height<300?640:height,touch,'detail&dialogLong'+(dark?'&siteDark':''),false);
    await wait(`document.querySelector('.book-detail-page')?.dataset.navigationLoading==='false'`);
    await evaluate(`document.documentElement.style.fontSize='${font}px'`);await sleep(150);
    await open(kind);
    if(height<300){await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:touch});await sleep(180);}
    if(scale!==1){await command('Emulation.setPageScaleFactor',{pageScaleFactor:scale});await sleep(200);}
    const label=`${kind} ${width}x${height} font${font} scale${scale} ${dark?'dark':'light'}`;
    const initial=await snapshot();observations.push({label,initial});
    console.log('BOOK_DIALOG_OBSERVED',JSON.stringify(observations.at(-1)));
    await screenshot(`book-dialog-${kind}-${width}-${height}-${font}-${scale}${baseline?'-baseline':''}`);
    if(!baseline){
      const r=initial.dialog,v=initial.viewport;
      ensure(!initial.overflow&&!initial.portalOverflow,label+' dialog content fits without horizontal scrolling',initial);
      ensure(r.left>=v.left&&r.right<=v.left+v.width+1&&r.top>=v.top&&r.bottom<=v.top+v.height+1,label+' dialog stays inside the visible viewport',initial);
      ensure(initial.close.width===44&&initial.close.height===44&&initial.icons.every(i=>i.width<=24&&i.height<=24),label+' controls retain compact 44px targets and bounded icons',initial);
      ensure(initial.fields.every(f=>f.left>=r.left&&f.right<=r.right+1),label+' fields stay within the dialog width',initial.fields);
      const last=`Array.from(${dialog}.querySelectorAll('button')).filter(e=>!e.disabled).at(-1)`;
      await evaluate(`${last}.scrollIntoView({block:'center',inline:'nearest'})`);await sleep(80);
      ensure(await visible(last),label+' last enabled action is reachable');
    }
    // A native keyboard traversal must keep focus inside and reveal its target.
    if(!baseline){
      await evaluate(`${dialog}.querySelector('button').focus()`);await key('Tab',true);
      ensure(await evaluate(`${dialog}.contains(document.activeElement)`)&&await visible('document.activeElement'),label+' Shift Tab wraps to a visible final action');
      await key('Tab');
      ensure(await evaluate(`document.activeElement===${dialog}.querySelector('button')`)&&await visible('document.activeElement'),label+' Tab wraps to the visible close action');
      await key('Escape');await wait(`!${dialog}`);
      ensure(await evaluate(`document.body.style.position!=='fixed'&&document.activeElement?.getAttribute('aria-label')==='更多操作'`),label+' Escape restores the page and opener');
    }
  }
  await command('Emulation.setPageScaleFactor',{pageScaleFactor:1});
  if(!baseline){
    const action=text=>`Array.from(${dialog}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
    const field=label=>`Array.from(${dialog}.querySelectorAll('label')).find(e=>e.firstChild?.textContent.trim()===${JSON.stringify(label)}).querySelector('input,textarea')`;
    const fill=async(expression,text)=>{await evaluate(`${expression}.scrollIntoView({block:'center'});${expression}.focus();${expression}.select()`);await command('Input.insertText',{text});await sleep(80);};
    const reset=async(width,height,touch,font,dark)=>{
      await fresh(width,height,touch,'detail&dialogLong'+(dark?'&siteDark':''),false);await wait(`document.querySelector('.book-detail-page')?.dataset.navigationLoading==='false'`);
      await evaluate(`document.documentElement.style.fontSize='${font}px'`);await sleep(120);
    };
    const settledSave=async(submit,label,verifyDraft)=>{
      await evaluate(`window.dialogSubmitButton=${submit};true`);submit='window.dialogSubmitButton';
      await evaluate('resumeFixture.holdMutation=true;resumeFixture.mutationStatus=503');await pointer(submit);await wait('resumeFixture.pendingMutations.length===1');
      const before=await evaluate('resumeFixture.bookMutations.length');
      await evaluate(`${submit}.click();${submit}.click()`);
      ensure(await evaluate('resumeFixture.bookMutations.length')===before,label+' repeated submit sends one pending write');
      await key('Escape');
      ensure(await evaluate(`!!${dialog}&&${dialog}.querySelector('button').disabled`),label+' pending save keeps the draft open and controls disabled');
      await evaluate('resumeFixture.holdMutation=false;resumeFixture.pendingMutations.splice(0).forEach(resolve=>resolve())');
      await wait(`!!${dialog}.querySelector('[role=alert]')&&!${submit}.disabled`);
      ensure(await evaluate(verifyDraft)&&!(await snapshot()).overflow,label+' failed save keeps its draft and long error readable');
      await evaluate('resumeFixture.mutationStatus=0');await pointer(submit);await wait(`!${dialog}`);
      ensure(await evaluate('resumeFixture.bookMutations.length')===before+1,label+' explicit retry completes one additional write');
    };
    for(const [width,height,touch,font,dark] of [[1536,864,false,16,false],[320,640,true,32,true],[844,390,true,32,false]]){
      const label=`${width}x${height} font${font} ${dark?'dark':'light'}`;
      await reset(width,height,touch,font,dark);await open('edit');
      await fill(field('书名'),' ');await pointer(action('保存'));
      ensure(await evaluate(`document.activeElement===${field('书名')}&&${field('书名')}.getAttribute('aria-invalid')==='true'&&document.querySelector('#edit-book-validation').textContent==='书名不能为空'`)&&await visible(field('书名')),label+' empty title validation focuses its visible field');
      await fill(field('书名'),'保留的手动书名');await fill(field('顺序'),'not-a-number');await pointer(action('保存'));
      ensure(await evaluate(`document.activeElement===${field('顺序')}&&${field('顺序')}.getAttribute('aria-invalid')==='true'`)&&await visible(field('顺序')),label+' invalid series order focuses its visible field');
      await fill(field('顺序'),'2.5');await fill(`document.querySelector('#edit-book-source-url')`,'https://kakuyomu.jp/works/1234');
      await evaluate('resumeFixture.holdMetadata=true');await pointer(action('读取资料'));await wait('resumeFixture.pendingMetadata.length===1');
      await fill(field('作者'),'保留的手动作者');await fill(field('简介'),'保留的手动简介');
      await evaluate('resumeFixture.holdMetadata=false;resumeFixture.pendingMetadata.splice(0).forEach(r=>r.resolve())');await wait(`!!${dialog}.querySelector('[aria-live=polite]')`);
      ensure(await evaluate(`${field('作者')}.value==='保留的手动作者'&&${field('简介')}.value==='保留的手动简介'&&${field('书名')}.value==='保留的手动书名'`)&&!(await snapshot()).overflow,label+' source lookup preserves edits made while reading and wraps long metadata');
      await screenshot('book-dialog-edit-source-'+width);
      await settledSave(action('保存'),label+' metadata',`${field('书名')}.value==='保留的手动书名'&&${field('简介')}.value==='保留的手动简介'`);
      ensure(await evaluate(`resumeFixture.bookMutations.at(-1).body.series_order===2.5&&resumeFixture.bookMutations.at(-1).body.author==='保留的手动作者'&&document.querySelector('.book-detail-page h1').textContent==='保留的手动书名'`),label+' saved metadata updates the book with the preserved draft');

      await reset(width,height,touch,font,dark);await open('source');
      await fill(`document.querySelector('#source-link-url')`,'https://kakuyomu.jp/works/1111');await evaluate('resumeFixture.holdMetadata=true');await pointer(action('读取资料'));await wait('resumeFixture.pendingMetadata.length===1');
      await fill(`document.querySelector('#source-link-url')`,'https://kakuyomu.jp/works/2222');
      await evaluate('resumeFixture.holdMetadata=false;resumeFixture.pendingMetadata.splice(0).forEach(r=>r.resolve())');await sleep(140);
      ensure(await evaluate(`resumeFixture.metadataReads[0].signal.aborted&&document.querySelector('#source-link-url').value.endsWith('/2222')&&!${dialog}.querySelector('[aria-live=polite]')`),label+' changing source ignores the cancelled lookup result');
      await evaluate('resumeFixture.metadataStatus=503');await pointer(action('读取资料'));await wait(`!!${dialog}.querySelector('[role=alert]')`);
      ensure(!(await snapshot()).overflow&&await evaluate(`document.querySelector('#source-link-url').value.endsWith('/2222')`),label+' source lookup failure keeps the entered URL for retry');
      await evaluate('resumeFixture.metadataStatus=0;resumeFixture.holdMetadata=true');await pointer(action('读取资料'));await wait('resumeFixture.pendingMetadata.length===1');
      await pointer(action('已完结'));await evaluate('resumeFixture.holdMetadata=false;resumeFixture.pendingMetadata.splice(0).forEach(r=>r.resolve())');await wait(`!!${dialog}.querySelector('[aria-live=polite]')`);
      const sourcePreview=await snapshot();
      ensure(!sourcePreview.overflow&&await evaluate(`${action('已完结')}.getAttribute('aria-pressed')==='true'`),label+' long source preview fits and preserves the chosen publication status',sourcePreview);
      await screenshot('book-dialog-source-metadata-'+width);
      await settledSave(action('保存关联'),label+' source',`document.querySelector('#source-link-url').value.endsWith('/2222')&&!!${dialog}.querySelector('[aria-live=polite]')`);
      ensure(await evaluate(`resumeFixture.bookMutations.at(-1).body.auto_translate_updates===false&&resumeFixture.bookMutations.at(-1).body.publication_status==='completed'&&resumeFixture.bookMutations.at(-1).body.source_url.endsWith('/2222')`),label+' source save uses the chosen status and current URL');
      await open('source');await pointer(action('移除关联'));await pointer(action('确认移除'));await wait(`!${dialog}`);
      ensure(await evaluate('resumeFixture.bookMutations.at(-1).body.source_url===null&&resumeFixture.bookMutations.at(-1).body.auto_translate_updates===false'),label+' removing the source clears its association');

      await reset(width,height,touch,font,dark);await open('cover');
      const selectFile=async code=>{await evaluate(`(async()=>{const input=${dialog}.querySelector('input[type=file]');const file=${code};const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(100);};
      for(const [file,message] of [[`new File([],'empty.png',{type:'image/png'})`,'空文件'],[`new File(['data'],'wrong.gif',{type:'image/gif'})`,'JPG'],[`new File([new Uint8Array(10*1024*1024+1)],'large.png',{type:'image/png'})`,'10 MB'],[`new File(['corrupt image'],'broken.png',{type:'image/png'})`,'无法预览']]){
        await selectFile(file);await wait(`${dialog}.querySelector('[role=alert]')?.textContent.includes(${JSON.stringify(message)})`);
        ensure(await evaluate(`${dialog}.querySelector('[aria-label="保存封面"]').disabled&&resumeFixture.bookMutations.length===0`),label+' invalid cover '+message+' cannot be saved');
      }
      await selectFile(`await new Promise(resolve=>{const canvas=document.createElement('canvas');canvas.width=240;canvas.height=360;const c=canvas.getContext('2d');c.fillStyle='#f5d3dc';c.fillRect(0,0,240,360);canvas.toBlob(blob=>resolve(new File([blob],'preview.png',{type:'image/png'})),'image/png')})`);
      await wait(`!${dialog}.querySelector('[aria-label="保存封面"]').disabled`);
      ensure(await evaluate(`!!${dialog}.querySelector('img[alt="新封面预览"]')&&${dialog}.querySelector('img[alt="新封面预览"]').naturalWidth===240&&!${dialog}.querySelector('[role=alert]')`),label+' valid replacement clears errors and decodes its real preview');
      const save=`${dialog}.querySelector('[aria-label="保存封面"]')`;
      await settledSave(save,label+' cover',`!!${dialog}.querySelector('img[alt="新封面预览"]')&&!${save}.disabled`);
      ensure(await evaluate(`resumeFixture.bookMutations.at(-1).body.name==='preview.png'&&resumeFixture.bookMutations.at(-1).body.size>0`),label+' cover retry uploads the selected file');
      await open('cover');await pointer(action('恢复原封面'));await wait(`!${dialog}`);
      ensure(await evaluate(`resumeFixture.bookMutations.at(-1).method==='DELETE'&&resumeFixture.book.cover_url===null`),label+' restoring the original cover completes its intended action');
    }
  }
  fs.writeFileSync(path.join(reportDir,baseline?'book-dialog-baseline.json':'book-dialog-observations.json'),JSON.stringify({observations},null,2));
}
