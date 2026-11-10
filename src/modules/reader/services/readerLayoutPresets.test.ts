import { describe, expect, it } from 'vitest';
import { DEFAULT_READER_PREFERENCES } from './readerPreferences';
import { getReaderLayoutPreset, READER_LAYOUT_PRESETS } from './readerLayoutPresets';

describe('reader layout selection', () => {
  it('shows a custom layout when paragraph spacing or measure differs', () => {
    expect(getReaderLayoutPreset({ ...DEFAULT_READER_PREFERENCES, paragraphSpacing: 'tight' })).toBeNull();
    expect(getReaderLayoutPreset({ ...DEFAULT_READER_PREFERENCES, contentWidth: 'wide' })).toBeNull();
  });

  it('recognizes rhythm independently of font, theme, and alignment', () => {
    expect(getReaderLayoutPreset({ ...DEFAULT_READER_PREFERENCES, fontFamily: 'sans', theme: 'dark', textAlign: 'left' })).toBe('comfortable');
  });

  it('changes rhythm while preserving unrelated reading choices', () => {
    const current = { ...DEFAULT_READER_PREFERENCES, fontWeight: 'bold' as const, textIndent: 'none' as const, theme: 'dark' as const };
    const updated = { ...current, ...READER_LAYOUT_PRESETS.compact };
    expect(getReaderLayoutPreset(updated)).toBe('compact');
    expect(updated.fontWeight).toBe('bold');
    expect(updated.textIndent).toBe('none');
    expect(updated.theme).toBe('dark');
  });
});
