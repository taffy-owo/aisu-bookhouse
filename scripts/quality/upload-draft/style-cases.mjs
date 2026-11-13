/** Compare the actual home and Japanese page at the same viewport and theme. */
export async function verifyPageStyle({ evaluate, wait, ensure, fresh, shot }) {
  for (const [width, height, touch, dark] of [[1536, 960, false, true], [390, 844, true, false]]) {
    const theme = dark ? '&dark' : '';
    await fresh(`home&styleMatch${theme}`, width, height, touch);
    await wait('!!document.querySelector(".home-compact-page h1")');
    const headingStyle = await evaluate(`(()=>{const h=document.querySelector('.home-compact-page h1'),s=getComputedStyle(h);return{font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,color:s.color}})()`);
    await shot('style-home-' + width);
    await evaluate('draftFixture.navigate("/japanese")');
    await wait('!!document.querySelector(".japanese-continue")');
    const japaneseStyle = await evaluate(`(()=>{const h=document.querySelector('.japanese-page h1'),s=getComputedStyle(h);return{font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,color:s.color}})()`);
    ensure(JSON.stringify(headingStyle) === JSON.stringify(japaneseStyle), width + ' home and Japanese headings share their font, size, weight and color', { headingStyle, japaneseStyle });
    ensure(await evaluate('getComputedStyle(document.querySelector(".japanese-page-header"),"::before").content==="none"&&getComputedStyle(document.querySelector(".japanese-page"),"::after").backgroundImage==="none"'), width + ' Japanese page uses the global sakura background without extra lettering or petals');
    ensure(await evaluate('document.documentElement.scrollWidth<=innerWidth&&document.querySelector(".japanese-continue").innerText.includes("42%")'), width + ' continued reading shows a labeled progress value and fits the viewport');
    await shot('style-japanese-' + width);
    await evaluate(`(()=>{const e=document.querySelector('.japanese-source-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate('document.querySelector(".japanese-start-button").click()');
    await wait('!!document.querySelector(".japanese-inline-reader")');
    ensure(await evaluate('document.documentElement.scrollWidth<=innerWidth&&getComputedStyle(document.querySelector(".japanese-inline-reader")).display!=="none"'), width + ' pasted text still opens the inline reader');
  }
}
