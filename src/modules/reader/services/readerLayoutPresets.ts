import type { ReaderPreferences } from './readerPreferences';

type Layout = Pick<ReaderPreferences, 'lineHeight' | 'pagePadding' | 'paragraphSpacing' | 'contentWidth'>;
export const READER_LAYOUT_PRESETS = {
  compact: { lineHeight: 'compact', pagePadding: 'compact', paragraphSpacing: 'tight', contentWidth: 'comfortable' },
  comfortable: { lineHeight: 'comfortable', pagePadding: 'comfortable', paragraphSpacing: 'normal', contentWidth: 'comfortable' },
  loose: { lineHeight: 'loose', pagePadding: 'wide', paragraphSpacing: 'loose', contentWidth: 'comfortable' },
} as const satisfies Record<string, Layout>;

export function getReaderLayoutPreset(preferences: ReaderPreferences): keyof typeof READER_LAYOUT_PRESETS | null {
  return (Object.keys(READER_LAYOUT_PRESETS) as Array<keyof typeof READER_LAYOUT_PRESETS>).find((key) => {
    const preset = READER_LAYOUT_PRESETS[key];
    return (Object.keys(preset) as Array<keyof Layout>).every((field) => preferences[field] === preset[field]);
  }) ?? null;
}
