import { getAccountScope } from '../../../shared/api';
import { readJapaneseArticleDraft } from '../services/japaneseArticleDraft';
import { BookOpenText, ChevronDown, LoaderCircle, Pause, PencilLine, Play, Save, Sparkles, Square, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../shared/components/Button';
import { useTheme } from '../../../shared/theme';
import { cn } from '../../../shared/utils/cn';
import { NovelContent } from '../../reader/components/NovelContent';
import type { JapaneseFuriganaMode, JapaneseLayout, JapaneseTranslationMode } from '../services/japaneseLayoutPreferences';
import {
  validatePastedJapaneseArticle,
  type PastedJapaneseArticleInput,
} from '../services/pastedJapaneseArticle';
import { usePastedJapaneseArticleSave } from '../hooks/usePastedJapaneseArticleSave';

interface InlineJapaneseReadingWorkspaceProps {
  onImported: () => void;
}

type PreviewArticle = {
  content: string;
  title: string;
};

const layoutOptions: Array<{ label: string; value: JapaneseLayout }> = [
  { label: '横排易读', value: 'readable' },
  { label: '原版排版', value: 'original' },
];

const furiganaOptions: Array<{ label: string; value: JapaneseFuriganaMode }> = [
  { label: '点按注音', value: 'on-demand' },
  { label: '全部注音', value: 'all' },
  { label: '隐藏注音', value: 'off' },
];

export function InlineJapaneseReadingWorkspace({ onImported }: InlineJapaneseReadingWorkspaceProps) {
  const { theme } = useTheme();
  const [initialDraft] = useState(() => readJapaneseArticleDraft(getAccountScope()));
  const [title, setTitle] = useState(initialDraft?.input.title ?? '');
  const [author, setAuthor] = useState(initialDraft?.input.author ?? '');
  const [sourceUrl, setSourceUrl] = useState(initialDraft?.input.sourceUrl ?? '');
  const [content, setContent] = useState(initialDraft?.input.content ?? '');
  const [preview, setPreview] = useState<PreviewArticle | null>(null);
  const [layout, setLayout] = useState<JapaneseLayout>('readable');
  const [furiganaMode, setFuriganaMode] = useState<JapaneseFuriganaMode>('on-demand');
  const [translationMode, setTranslationMode] = useState<JapaneseTranslationMode>('off');
  const [speechRate, setSpeechRate] = useState(0.9);
  const [speechState, setSpeechState] = useState<'idle' | 'paused' | 'speaking'>('idle');
  const speechGenerationRef = useRef(0);
  const articleSave = usePastedJapaneseArticleSave(onImported, { title, author, sourceUrl, content }, initialDraft?.submission);
  const { draftStorageFailed, bookId, errorMessage, isSaving, startPreview, statusMessage, save, cancel, setErrorMessage } = articleSave;

  useEffect(() => () => {
    speechGenerationRef.current += 1;
    window.speechSynthesis?.cancel();
  }, []);

  const handleStartReading = () => {
    const input: PastedJapaneseArticleInput = { author, content, sourceUrl, title };
    const validationError = validatePastedJapaneseArticle(input);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    const nextPreview = { content: input.content.trim(), title: input.title?.trim() || '临时阅读' };
    startPreview(input);
    setPreview(nextPreview);
  };

  const handleSave = async () => {
    if (isSaving || bookId) return;
    const input: PastedJapaneseArticleInput = { author, content, sourceUrl, title };
    const validationError = validatePastedJapaneseArticle(input);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    await save(input);
  };

  const handleEdit = () => {
    cancel();
    stopSpeaking();
    setPreview(null);
  };

  const startSpeaking = (rate = speechRate) => {
    if (!('speechSynthesis' in window) || !preview) return;
    const generation = ++speechGenerationRef.current;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(preview.content);
    utterance.lang = 'ja-JP';
    utterance.rate = rate;
    utterance.onend = () => {
      if (speechGenerationRef.current === generation) setSpeechState('idle');
    };
    utterance.onerror = () => {
      if (speechGenerationRef.current === generation) setSpeechState('idle');
    };
    window.speechSynthesis.speak(utterance);
    setSpeechState('speaking');
  };

  const toggleSpeech = () => {
    if (!('speechSynthesis' in window)) return;
    if (speechState === 'paused') {
      window.speechSynthesis.resume();
      setSpeechState('speaking');
    } else if (speechState === 'speaking') {
      window.speechSynthesis.pause();
      setSpeechState('paused');
    } else {
      startSpeaking();
    }
  };

  const stopSpeaking = () => {
    speechGenerationRef.current += 1;
    window.speechSynthesis?.cancel();
    setSpeechState('idle');
  };

  if (preview) {
    return (
      <section className="japanese-inline-reader japanese-workspace mt-6 overflow-hidden">
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-ink/[0.08] bg-paper/95 px-3 py-2 backdrop-blur-xl dark:border-white/10 dark:bg-night-surface/95 sm:px-4">
          <SegmentedControl onChange={setLayout} options={layoutOptions} value={layout} />
          <SegmentedControl onChange={setFuriganaMode} options={furiganaOptions} value={furiganaMode} />
          <div className="ml-auto flex items-center gap-1">
            <button
              aria-pressed={translationMode === 'bilingual'}
              className={cn('inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm transition', translationMode === 'bilingual' ? 'bg-accent/10 text-accent dark:bg-peach/10 dark:text-peach' : 'text-stone-600 hover:bg-black/[0.05] dark:text-night-soft dark:hover:bg-white/[0.07]')}
              onClick={() => setTranslationMode((mode) => mode === 'bilingual' ? 'off' : 'bilingual')}
              title="保留日文原文，在段落下方显示 AI 译文"
              type="button"
            >
              <Sparkles className="h-4 w-4" />双语
            </button>
            <select
              aria-label="朗读语速"
              className="h-9 rounded-md border border-current/[0.08] bg-transparent px-1.5 text-xs text-stone-500 outline-none dark:text-night-soft"
              onChange={(event) => {
                const rate = Number(event.target.value);
                setSpeechRate(rate);
                if (speechState !== 'idle') startSpeaking(rate);
              }}
              value={speechRate}
            >
              <option value={0.7}>0.7x</option>
              <option value={0.9}>0.9x</option>
              <option value={1}>1.0x</option>
              <option value={1.2}>1.2x</option>
            </select>
            <button aria-label={speechState === 'speaking' ? '暂停朗读' : speechState === 'paused' ? '继续朗读' : '朗读全文'} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-stone-600 transition hover:bg-black/[0.05] dark:text-night-soft dark:hover:bg-white/[0.07]" onClick={toggleSpeech} type="button">
              {speechState === 'speaking' ? <Pause className="h-4 w-4" /> : speechState === 'paused' ? <Play className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              {speechState === 'speaking' ? '暂停' : speechState === 'paused' ? '继续' : '朗读'}
            </button>
            {speechState !== 'idle' && <button aria-label="停止朗读" className="grid h-10 w-10 place-items-center rounded-lg text-stone-500 transition hover:bg-black/[0.05] dark:text-night-soft dark:hover:bg-white/[0.07]" onClick={stopSpeaking} title="停止朗读" type="button"><Square className="h-4 w-4" /></button>}
            <button aria-label="编辑原文" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-stone-600 transition hover:bg-black/[0.05] dark:text-night-soft dark:hover:bg-white/[0.07]" onClick={handleEdit} type="button">
              <PencilLine className="h-4 w-4" />编辑
            </button>
        </div>
        </div>

        <div className={cn('flex min-h-12 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs sm:px-4', errorMessage ? 'border-red-200/70 bg-red-50 text-red-600 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300' : 'border-accent/10 bg-accent/[0.055] text-accent dark:text-peach')}>
          {isSaving && <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />}
          <span className="min-w-0 flex-1">{draftStorageFailed ? '草稿暂时无法保存在浏览器，请在离开前复制正文。' : errorMessage || statusMessage || (bookId ? '已保存到书架' : '当前仅临时阅读，不会自动加入书架')}</span>
          {!bookId && (
            <button
              className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-white transition hover:bg-accent-deep disabled:opacity-55"
              disabled={isSaving}
              onClick={() => void handleSave()}
              type="button"
            >
              {isSaving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {isSaving ? '保存中' : '保存到书架'}
            </button>
          )}
          </div>

        <div className={cn('japanese-inline-content xl:max-h-[72dvh] xl:overflow-y-auto reader-scrollbar', theme === 'dark' ? 'reader-theme-dark' : 'reader-theme-paper')}>
          <NovelContent
            bookId={bookId}
            chapterTitle={preview.title}
            chapterTitleLanguage={title.trim() ? '' : 'zh-CN'}
            content={preview.content}
            embedded
            language="ja"
            japaneseFuriganaMode={furiganaMode}
            japaneseLayout={layout}
            japaneseTranslationMode={translationMode}
            readerTheme={theme === 'dark' ? 'dark' : 'paper'}
            title="日文阅读"
            titleLanguage="zh-CN"
          />
        </div>
      </section>
    );
  }

  return (
    <section className="japanese-workspace mt-6 lg:mt-4">
      <div className="japanese-workspace-heading flex items-center gap-2 text-sm font-semibold text-stone-800 dark:text-night-ink">
        <BookOpenText className="h-4 w-4 text-accent dark:text-peach" />
        粘贴日文正文
      </div>

      <p className="japanese-workspace-note mt-2 text-xs text-stone-500 dark:text-stone-400" role={draftStorageFailed ? 'status' : undefined}>
        {draftStorageFailed ? '草稿暂时无法保存在浏览器，请在离开前复制正文。' : initialDraft ? '已恢复本标签页的草稿。' : '草稿保留在本标签页，返回或刷新后可继续。'}
      </p>
      <textarea
        aria-label="日文正文"
        className="japanese-source-input mt-4 min-h-[180px] w-full resize-y px-4 py-3 font-serif text-[16px] leading-8 outline-none transition placeholder:text-stone-500 focus:border-accent focus:ring-2 focus:ring-accent/15 dark:placeholder:text-stone-600"
        onChange={(event) => setContent(event.target.value)}
        placeholder="把日文文章粘贴到这里…"
        value={content}
      />

      <div className="japanese-workspace-actions mt-2 flex items-center justify-between gap-3">
        <span className="japanese-character-count text-xs tabular-nums text-stone-400">{content.length.toLocaleString()} 字符</span>
        <Button className="japanese-start-button" icon={<BookOpenText className="h-4 w-4" />} onClick={handleStartReading}>
          开始阅读
        </Button>
      </div>

      <details className="japanese-details group mt-3 border-t border-ink/[0.07] pt-2 dark:border-white/10">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 text-sm text-stone-500 dark:text-stone-400">
          标题、作者和原文链接（可选）
          <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div className="grid gap-4 pb-1 pt-3 sm:grid-cols-2">
          <Field label="标题">
            <input className={inputClassName} onChange={(event) => setTitle(event.target.value)} placeholder="自动取正文第一行" value={title} />
          </Field>
          <Field label="作者">
            <input className={inputClassName} onChange={(event) => setAuthor(event.target.value)} placeholder="网络文章" value={author} />
          </Field>
          <Field className="sm:col-span-2" label="原文链接">
            <input className={inputClassName} inputMode="url" onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…" value={sourceUrl} />
          </Field>
        </div>
      </details>

      {errorMessage && <p className="japanese-error mt-3 px-3 py-2 text-sm text-red-600 dark:text-red-300">{errorMessage}</p>}
    </section>
  );
}

function SegmentedControl<TValue extends string>({ className, onChange, options, value }: { className?: string; onChange: (value: TValue) => void; options: Array<{ label: string; value: TValue }>; value: TValue }) {
  return (
    <div className={cn('flex rounded-lg border border-current/[0.08] bg-current/[0.025] p-1', className)}>
      {options.map((option) => (
        <button className={cn('min-h-8 rounded-md px-2.5 text-xs transition', option.value === value ? 'bg-accent text-white shadow-sm' : 'text-stone-500 hover:bg-black/[0.04] dark:text-stone-400 dark:hover:bg-white/[0.06]')} key={option.value} onClick={() => onChange(option.value)} type="button">
          {option.label}
        </button>
      ))}
    </div>
  );
}

const inputClassName = 'japanese-details-input min-h-11 w-full px-3 text-sm text-stone-800 outline-none transition placeholder:text-stone-500 focus:border-accent focus:ring-2 focus:ring-accent/15 dark:text-night-ink dark:placeholder:text-stone-600';

function Field({ children, className = '', label }: { children: ReactNode; className?: string; label: string }) {
  return <label className={`grid gap-2 text-sm font-medium text-stone-700 dark:text-night-copy ${className}`}>{label}{children}</label>;
}

