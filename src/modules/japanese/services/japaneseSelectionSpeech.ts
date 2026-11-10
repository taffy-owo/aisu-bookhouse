/** Return a cancellation handle that only remains active for this utterance. */
export function speakJapaneseSelection(text: string, onEnd: () => void, onError: (message: string) => void): () => void {
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
    throw new Error('当前浏览器不支持设备朗读');
  }
  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  let active = true;
  const detach = () => {
    active = false;
    utterance.onend = null;
    utterance.onerror = null;
  };
  const stop = () => {
    if (!active) return;
    detach();
    synth.cancel();
  };
  utterance.lang = 'ja-JP';
  utterance.rate = 0.9;
  utterance.onend = () => {
    if (!active) return;
    detach();
    onEnd();
  };
  utterance.onerror = (event) => {
    if (!active) return;
    detach();
    if (event.error === 'canceled' || event.error === 'interrupted') onEnd();
    else onError(event.error === 'language-unavailable' || event.error === 'voice-unavailable'
      ? '设备没有可用的日语语音，请检查系统语音设置'
      : '设备朗读失败，请重试');
  };
  try {
    synth.cancel();
    synth.speak(utterance);
    if (active && synth.paused) synth.resume();
  } catch {
    stop();
    throw new Error('设备朗读失败，请重试');
  }
  return stop;
}
