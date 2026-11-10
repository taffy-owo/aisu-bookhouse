import { useDialogViewport } from '../../../shared/hooks/useDialogViewport';
import { Columns3, Languages, MousePointer2, Sparkles, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useReaderPanelDismiss } from '../../reader/hooks/useReaderPanelDismiss';
import type { ReaderTheme } from '../../reader/types/reader';
import { cn } from '../../../shared/utils/cn';
import type { JapaneseFuriganaMode, JapaneseLayout, JapaneseTranslationMode } from '../services/japaneseLayoutPreferences';

interface JapaneseReaderToolsPanelProps {
  furiganaMode: JapaneseFuriganaMode;
  theme: ReaderTheme;
  layout: JapaneseLayout;
  onChangeFurigana: (mode: JapaneseFuriganaMode) => void;
  onChangeLayout: (layout: JapaneseLayout) => void;
  onChangeTranslation: (mode: JapaneseTranslationMode) => void;
  onClose: () => void;
  translationMode: JapaneseTranslationMode;
}

const layoutOptions: Array<{ label: string; value: JapaneseLayout }> = [
  { label: '横排易读', value: 'readable' },
  { label: '原版排版', value: 'original' },
];

const furiganaOptions: Array<{ label: string; value: JapaneseFuriganaMode }> = [
  { label: '点按显示', value: 'on-demand' },
  { label: '全部显示', value: 'all' },
  { label: '隐藏', value: 'off' },
];

const translationOptions: Array<{ label: string; value: JapaneseTranslationMode }> = [
  { label: '仅原文', value: 'off' },
  { label: '双语对照', value: 'bilingual' },
];

export function JapaneseReaderToolsPanel({
  furiganaMode,
  theme,
  layout,
  onChangeFurigana,
  onChangeLayout,
  onChangeTranslation,
  onClose,
  translationMode,
}: JapaneseReaderToolsPanelProps) {
  const panelRef = useReaderPanelDismiss({ onClose });
  const viewportRef = useDialogViewport();

  return (
    <div ref={viewportRef} className="reader-panel-backdrop viewport-dialog fixed inset-0 z-[90]" onClick={onClose}>
      <aside
        aria-label="日文阅读设置"
        aria-modal="true"
        className={cn(
          'reader-panel-sheet reader-japanese-tools absolute inset-x-0 bottom-0 flex w-full flex-col focus:outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[390px]',
          `reader-theme-${theme}`,
        )}
        onClick={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="reader-panel-heading flex items-center justify-between px-5 pb-4 pt-5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Languages className="h-4 w-4 text-[color:var(--reader-accent)]" />
            <h2 className="font-display text-xl font-semibold">日文阅读</h2>
          </div>
          <button aria-label="关闭日文阅读设置" className="grid h-11 w-11 place-items-center rounded-full transition hover:bg-current/10" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-6 reader-scrollbar sm:px-6">
          <SettingSection icon={<Columns3 className="h-4 w-4" />} label="正文排版">
            <SegmentedControl onChange={onChangeLayout} options={layoutOptions} value={layout} />
          </SettingSection>

          <SettingSection icon={<MousePointer2 className="h-4 w-4" />} label="振假名">
            <SegmentedControl onChange={onChangeFurigana} options={furiganaOptions} value={furiganaMode} />
            {furiganaMode === 'on-demand' && <p className="reader-muted mt-3 text-xs leading-6">点按带注音的文字时显示读音，正文平时保持干净。</p>}
          </SettingSection>

          <SettingSection icon={<Sparkles className="h-4 w-4" />} label="AI 译文">
            <SegmentedControl onChange={onChangeTranslation} options={translationOptions} value={translationMode} />
            {translationMode === 'bilingual' && <p className="reader-muted mt-3 text-xs leading-6">保留日文原文，在段落下方显示 AI 译文。使用网页翻译时可切回“仅原文”。</p>}
          </SettingSection>

          <div className="reader-settings-advanced reader-muted px-1 pt-4 text-xs leading-6">
            选中单词可查词，选中句子可单独 AI 翻译或朗读。
          </div>
        </div>
      </aside>
    </div>
  );
}

function SettingSection({ children, icon, label }: { children: ReactNode; icon: ReactNode; label: string }) {
  return (
    <section>
      <div className="reader-muted mb-3 flex items-center gap-2 text-xs font-semibold">{icon}<span>{label}</span></div>
      {children}
    </section>
  );
}

function SegmentedControl<TValue extends string>({
  onChange,
  options,
  value,
}: {
  onChange: (value: TValue) => void;
  options: Array<{ label: string; value: TValue }>;
  value: TValue;
}) {
  return (
    <div className="reader-segmented-control flex">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={cn(
            'relative min-h-11 flex-1 px-2 py-1 text-xs font-medium transition-colors duration-200',
            option.value === value ? 'reader-segmented-active text-[color:var(--reader-accent)]' : 'reader-muted hover:text-[color:var(--reader-ink)]',
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
