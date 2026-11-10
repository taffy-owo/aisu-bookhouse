import { useDialogViewport } from '../../../shared/hooks/useDialogViewport';
import { Check, ChevronDown, Languages, Palette, RotateCcw, Rows3, SlidersHorizontal, Sun, Type, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '../../../shared/utils/cn';
import { useMediaQuery } from '../../../shared/hooks/useMediaQuery';
import { useReaderPanelDismiss } from '../hooks/useReaderPanelDismiss';
import { DEFAULT_READER_PREFERENCES, type ReaderPreferences } from '../services/readerPreferences';
import type { ReaderTheme } from '../types/reader';
import { getReaderLayoutPreset, READER_LAYOUT_PRESETS } from '../services/readerLayoutPresets';

interface ReaderSettingsPanelProps {
  appearanceOnly?: boolean;
  fontSizeControl?: ReactNode;
  isDark?: boolean;
  pdfPageAppearance?: boolean;
  onChange: (preferences: ReaderPreferences) => void;
  onClose: () => void;
  preferences: ReaderPreferences;
  onReset?: () => void;
  showChineseScript?: boolean;
}

const themeOptions: Array<{ label: string; value: ReaderTheme }> = [
  { label: '纸书', value: 'paper' },
  { label: '净白', value: 'white' },
  { label: '护眼', value: 'green' },
  { label: '夜间', value: 'dark' },
];

const fontFamilyOptions: Array<{ className: string; label: string; value: ReaderPreferences['fontFamily'] }> = [
  { className: 'reader-font-source-serif', label: '思源宋', value: 'serif' },
  { className: 'reader-font-wenkai', label: '文楷', value: 'wenkai' },
  { className: 'reader-font-song', label: '书宋', value: 'song' },
  { className: 'reader-font-sans-cjk', label: '黑体', value: 'sans' },
];

const layoutPresetOptions: Array<{ label: string; value: 'compact' | 'comfortable' | 'loose' }> = [
  { label: '紧凑', value: 'compact' },
  { label: '适中', value: 'comfortable' },
  { label: '宽松', value: 'loose' },
];

const fontWeightOptions: Array<{ label: string; value: ReaderPreferences['fontWeight'] }> = [
  { label: '常规', value: 'regular' },
  { label: '稍粗', value: 'medium' },
  { label: '加粗', value: 'bold' },
];

const lineHeightOptions: Array<{ label: string; value: ReaderPreferences['lineHeight'] }> = [
  { label: '紧', value: 'compact' },
  { label: '舒适', value: 'comfortable' },
  { label: '松', value: 'loose' },
];

const paragraphSpacingOptions: Array<{ label: string; value: ReaderPreferences['paragraphSpacing'] }> = [
  { label: '窄', value: 'tight' },
  { label: '标准', value: 'normal' },
  { label: '宽', value: 'loose' },
];

const contentWidthOptions: Array<{ label: string; value: ReaderPreferences['contentWidth'] }> = [
  { label: '窄栏', value: 'narrow' },
  { label: '适中', value: 'comfortable' },
  { label: '宽栏', value: 'wide' },
];

const pagePaddingOptions: Array<{ label: string; value: ReaderPreferences['pagePadding'] }> = [
  { label: '小', value: 'compact' },
  { label: '中', value: 'comfortable' },
  { label: '大', value: 'wide' },
];

const textAlignOptions: Array<{ label: string; value: ReaderPreferences['textAlign'] }> = [
  { label: '自动', value: 'auto' },
  { label: '左齐', value: 'left' },
  { label: '两端', value: 'justify' },
  { label: '居中', value: 'center' },
];

const textIndentOptions: Array<{ label: string; value: ReaderPreferences['textIndent'] }> = [
  { label: '无', value: 'none' },
  { label: '标准', value: 'normal' },
  { label: '宽', value: 'wide' },
];

const readingModeOptions: Array<{ label: string; value: ReaderPreferences['readingMode'] }> = [
  { label: '上下滚动', value: 'scroll' },
  { label: '左右翻页', value: 'paged' },
];

const chineseScriptOptions: Array<{ label: string; value: ReaderPreferences['chineseScript'] }> = [
  { label: '保留原文', value: 'original' },
  { label: '转为简体', value: 'simplified' },
];

export function ReaderSettingsPanel({ appearanceOnly = false, fontSizeControl, onChange, onClose, onReset, pdfPageAppearance = false, preferences, showChineseScript = true }: ReaderSettingsPanelProps) {
  const panelRef = useReaderPanelDismiss({ onClose });
  const viewportRef = useDialogViewport();
  const hasTouchInput = useMediaQuery('(any-pointer: coarse)');
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'display' | 'operation'>('display');
  const updatePreference = <TKey extends keyof ReaderPreferences>(key: TKey, value: ReaderPreferences[TKey]) => {
    onChange({ ...preferences, [key]: value });
  };

  const handleFontScaleChange = (direction: 1 | -1) => {
    const scaleMap: Record<ReaderPreferences['fontScale'], number> = { small: 0, medium: 1, large: 2 };
    const scales: Array<ReaderPreferences['fontScale']> = ['small', 'medium', 'large'];
    const currentIdx = scaleMap[preferences.fontScale];
    const nextIdx = Math.max(0, Math.min(2, currentIdx + direction));
    updatePreference('fontScale', scales[nextIdx]);
  };

  const activePreset = getReaderLayoutPreset(preferences);

  const handlePresetChange = (preset: keyof typeof READER_LAYOUT_PRESETS) => {
    onChange({ ...preferences, ...READER_LAYOUT_PRESETS[preset] });
  };

  return (
    <div ref={viewportRef} className="reader-panel-backdrop viewport-dialog reader-settings-backdrop fixed inset-0 z-[90]" onClick={onClose}>
      <aside
        aria-label="阅读设置"
        aria-modal="true"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
        className={cn(
          `reader-settings-panel reader-theme-${preferences.theme}`,
          'reader-panel-sheet reader-settings-sheet absolute inset-x-0 bottom-0 flex w-full flex-col focus:outline-none',
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="reader-panel-heading flex items-center justify-between px-5 pb-4 pt-5 sm:px-6">
          <h2 className="text-base font-semibold">阅读设置</h2>
          <button aria-label="关闭阅读设置" className="grid h-11 w-11 place-items-center rounded-full transition hover:bg-current/10" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>
        {!appearanceOnly && <div aria-label="设置分类" className="reader-settings-tabs flex gap-5 border-b border-current/10 px-5 sm:px-6">
          <button aria-label="显示设置" aria-pressed={settingsTab === 'display'} onClick={() => setSettingsTab('display')} type="button">显示</button>
          <button aria-label="操作设置" aria-pressed={settingsTab === 'operation'} onClick={() => setSettingsTab('operation')} type="button">操作</button>
        </div>}
        <div className="reader-settings-fields min-h-0 flex-1 overflow-y-auto px-5 py-4 reader-scrollbar sm:px-6">
          {appearanceOnly || settingsTab === 'display' ? (
            <div className="space-y-4">
              {!pdfPageAppearance && <SettingGroup icon={Type} label="字号">
                {fontSizeControl ?? <ReaderFontSizeControl
                  decreaseDisabled={preferences.fontScale === 'small'}
                  increaseDisabled={preferences.fontScale === 'large'}
                  label={{ small: '小号', medium: '中号', large: '大号' }[preferences.fontScale]}
                  onDecrease={() => handleFontScaleChange(-1)}
                  onIncrease={() => handleFontScaleChange(1)}
                />}
              </SettingGroup>}

              <SettingGroup icon={Palette} label="阅读主题">
                <ThemeSwatches options={pdfPageAppearance ? themeOptions.map((option) => option.value === 'white' ? { ...option, label: '原色' } : option) : themeOptions} value={preferences.theme} onChange={(value) => updatePreference('theme', value)} />
                {pdfPageAppearance && <p className="reader-setting-muted mt-2 text-xs leading-5">彩页可选“原色”保留原图颜色。</p>}
              </SettingGroup>

              {pdfPageAppearance && <SettingGroup icon={Sun} label="纸面亮度">
                <div className="flex items-center gap-4">
                  <input aria-label="PDF 纸面亮度" className="h-11 min-w-0 flex-1" style={{ accentColor: 'var(--reader-accent)' }} type="range" min={50} max={100} step={5} value={preferences.pdfBrightness} onChange={(event) => updatePreference('pdfBrightness', Number(event.target.value))} />
                  <output className="reader-setting-muted w-10 text-right text-xs tabular-nums">{preferences.pdfBrightness}%</output>
                </div>
              </SettingGroup>}

              {!pdfPageAppearance && <SettingGroup icon={Type} label="字体">
                <SegmentedControl options={fontFamilyOptions} value={preferences.fontFamily} onChange={(value) => updatePreference('fontFamily', value)} />
              </SettingGroup>}

              {!appearanceOnly && <section className="reader-settings-advanced pt-1">
                <button aria-expanded={isAdvancedOpen} className="flex min-h-12 w-full items-center justify-between gap-3 px-1 text-left text-sm font-medium transition hover:text-[color:var(--reader-accent)]" onClick={() => setIsAdvancedOpen((open) => !open)} type="button">
                  <span className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-current/45" />高级排版</span>
                  <ChevronDown className={cn('h-4 w-4 text-current/40 transition-transform duration-300', isAdvancedOpen && 'rotate-180')} />
                </button>
                {isAdvancedOpen && (
                  <div className="reader-settings-reveal space-y-5 pb-1 pt-5">
                    {showChineseScript && (
                      <SettingGroup icon={Languages} label="繁简显示">
                        <SegmentedControl options={chineseScriptOptions} value={preferences.chineseScript} onChange={(value) => updatePreference('chineseScript', value)} />
                      </SettingGroup>
                    )}
                    <SettingGroup icon={Rows3} label="阅读密度">
                      <SegmentedControl options={layoutPresetOptions} value={activePreset ?? ''} onChange={handlePresetChange} />
                      {!activePreset && <p className="reader-setting-muted mt-2 text-xs">自定义排版 · 保留你的逐项调整</p>}
                    </SettingGroup>
                    <SettingGroup icon={Rows3} label="行距"><SegmentedControl options={lineHeightOptions} value={preferences.lineHeight} onChange={(value) => updatePreference('lineHeight', value)} /></SettingGroup>
                    <SettingGroup icon={Rows3} label="段距"><SegmentedControl options={paragraphSpacingOptions} value={preferences.paragraphSpacing} onChange={(value) => updatePreference('paragraphSpacing', value)} /></SettingGroup>
                    <SettingGroup icon={Rows3} label="栏宽"><SegmentedControl options={contentWidthOptions} value={preferences.contentWidth} onChange={(value) => updatePreference('contentWidth', value)} /></SettingGroup>
                    <SettingGroup icon={Rows3} label="页边距"><SegmentedControl options={pagePaddingOptions} value={preferences.pagePadding} onChange={(value) => updatePreference('pagePadding', value)} /></SettingGroup>
                    <SettingGroup icon={Type} label="字重"><SegmentedControl options={fontWeightOptions} value={preferences.fontWeight} onChange={(value) => updatePreference('fontWeight', value)} /></SettingGroup>
                    <SettingGroup icon={Rows3} label="对齐"><SegmentedControl options={textAlignOptions} value={preferences.textAlign} onChange={(value) => updatePreference('textAlign', value)} /></SettingGroup>
                    <SettingGroup icon={Rows3} label="首行缩进"><SegmentedControl options={textIndentOptions} value={preferences.textIndent} onChange={(value) => updatePreference('textIndent', value)} /></SettingGroup>
                  </div>
                )}
              </section>}
            </div>
          ) : (
            <div className="space-y-4">
              <SettingGroup icon={Rows3} label="翻阅方式">
                <SegmentedControl options={readingModeOptions} value={preferences.readingMode} onChange={(value) => updatePreference('readingMode', value)} />
              </SettingGroup>

              {hasTouchInput && (
                <SettingGroup icon={Rows3} label="轻点翻页">
                  <SegmentedControl options={[{ label: '开启', value: 'on' }, { label: '关闭', value: 'off' }]} value={preferences.tapToTurnPage ? 'on' : 'off'} onChange={(value) => updatePreference('tapToTurnPage', value === 'on')} />
                  <p className="reader-setting-muted mt-2 text-xs leading-5">左侧上一页 · 中间菜单 · 右侧下一页<br />读到章节边界后，再轻点换话；也可上下滑动阅读。</p>
                </SettingGroup>
              )}
            </div>
          )}
        </div>
        <div className="reader-settings-footer">
          <button className="reader-setting-muted inline-flex min-h-11 items-center justify-center gap-2 px-2 text-xs" onClick={onReset ?? (() => onChange({ ...DEFAULT_READER_PREFERENCES, pdfBrightness: preferences.pdfBrightness, pdfTextFontSize: preferences.pdfTextFontSize }))} type="button"><RotateCcw className="h-3.5 w-3.5" />恢复默认</button>
          <button className="reader-settings-done" onClick={onClose} type="button">完成</button>
        </div>
      </aside>
    </div>
  );
}

export function ReaderFontSizeControl({ decreaseDisabled, increaseDisabled, label, onDecrease, onIncrease }: {
  decreaseDisabled: boolean;
  increaseDisabled: boolean;
  label: string;
  onDecrease: () => void;
  onIncrease: () => void;
}) {
  // Keep a reached limit focusable, so the next Tab still follows the stepper.
  return <div className="reader-font-stepper flex items-center justify-between">
    <button aria-disabled={decreaseDisabled} aria-label="减小字号" className="reader-chrome-action grid h-10 w-10 shrink-0 place-items-center text-xs font-semibold aria-disabled:cursor-default aria-disabled:opacity-30" onClick={() => { if (!decreaseDisabled) onDecrease(); }} type="button">A−</button>
    <span aria-atomic="true" aria-label="当前字号" className="reader-setting-muted flex-1 select-none text-center text-xs font-semibold tabular-nums text-current/75" role="status">{label}</span>
    <button aria-disabled={increaseDisabled} aria-label="增大字号" className="reader-chrome-action grid h-10 w-10 shrink-0 place-items-center text-sm font-semibold aria-disabled:cursor-default aria-disabled:opacity-30" onClick={() => { if (!increaseDisabled) onIncrease(); }} type="button">A+</button>
  </div>;
}

function ThemeSwatches<TValue extends string>({
  onChange,
  options,
  value,
}: {
  onChange: (value: TValue) => void;
  options: Array<{ label: string; value: TValue }>;
  value: TValue;
}) {
  return (
    <div className="reader-theme-swatches grid grid-cols-4 gap-1.5">
      {options.map((option) => (
        <button
          aria-label={option.label}
          aria-pressed={option.value === value}
          className={cn(
            `reader-theme-swatch reader-theme-${option.value} relative flex min-h-11 items-center justify-center rounded-md border px-1 py-2 text-center text-xs`,
            option.value === value ? 'reader-theme-swatch-selected' : '',
          )}
          style={{ background: 'var(--reader-page)', color: 'var(--reader-ink)' }}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          <span>{option.label}</span>
          {option.value === value && <Check aria-hidden className="absolute right-1 top-1 h-2.5 w-2.5" />}
        </button>
      ))}
    </div>
  );
}

function SettingGroup({ children, icon: Icon, label }: { children: ReactNode; icon: LucideIcon; label: string }) {
  return (
    <section className="reader-setting-group">
      <div className="mb-2.5 flex items-end justify-between gap-3">
        <div className="reader-setting-muted flex items-center gap-2 text-xs font-semibold text-current/70"><Icon className="h-3.5 w-3.5 text-current/40" /><span>{label}</span></div>
      </div>
      {children}
    </section>
  );
}

function SegmentedControl<TValue extends string>({ onChange, options, value }: { onChange: (value: TValue) => void; options: Array<{ className?: string; label: string; value: TValue }>; value: TValue | '' }) {
  return (
    <div className="reader-segmented-control flex">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={cn(
            'relative min-h-10 flex-1 px-2 py-1 text-xs font-medium transition-colors duration-200',
            option.className,
            option.value === value
              ? 'reader-segmented-active text-accent'
              : 'reader-setting-muted text-current/[0.52] hover:text-current',
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
