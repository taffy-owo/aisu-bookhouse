import type { ReaderPreferences } from '../services/readerPreferences';
import type { ReaderTheme } from '../types/reader';

export const readerThemeClass: Record<ReaderTheme, string> = {
  dark: 'bg-[var(--reader-shell)] text-[color:var(--reader-ink)]',
  green: 'bg-[#879686] text-[#273229]',
  paper: 'bg-[#c1b296] text-[#332c24]',
  white: 'bg-[#dcddda] text-[#292b2d]',
};

export const readerFontClass: Record<ReaderPreferences['fontScale'], string> = {
  large: 'reader-font-large text-[21px] md:text-[23px]',
  medium: 'reader-font-medium text-[18px] md:text-[20px]',
  small: 'reader-font-small text-[16px] md:text-[18px]',
};

export const readerLineHeightClass: Record<ReaderPreferences['lineHeight'], string> = {
  comfortable: 'reader-line-comfortable leading-[1.9]',
  compact: 'reader-line-compact leading-[1.72]',
  loose: 'reader-line-loose leading-[2.12]',
};

export const readerFontWeightClass: Record<ReaderPreferences['fontWeight'], string> = {
  bold: 'font-bold',
  medium: 'font-medium',
  regular: 'font-normal',
};

export const readerContentWidthClass: Record<ReaderPreferences['contentWidth'], string> = {
  comfortable: 'max-w-[760px]',
  narrow: 'max-w-[640px]',
  wide: 'max-w-[920px]',
};

export const readerParagraphSpacingClass: Record<ReaderPreferences['paragraphSpacing'], string> = {
  loose: 'reader-paragraph-loose space-y-7',
  normal: 'reader-paragraph-normal space-y-5',
  tight: 'reader-paragraph-tight space-y-3',
};

export const readerPagePaddingClass: Record<ReaderPreferences['pagePadding'], string> = {
  comfortable: 'reader-padding-comfortable px-5 sm:px-6 md:px-12',
  compact: 'reader-padding-compact px-4 sm:px-5 md:px-8',
  wide: 'reader-padding-wide px-6 sm:px-10 md:px-16',
};

export const readerTextAlignClass: Record<ReaderPreferences['textAlign'], string> = {
  auto: 'text-left',
  center: 'text-center',
  justify: 'text-justify',
  left: 'text-left',
};

export const readerTextIndentClass: Record<ReaderPreferences['textIndent'], string> = {
  none: 'indent-0',
  normal: 'indent-[2em]',
  wide: 'indent-[3em]',
};

export const readerBodyFontClass: Record<ReaderPreferences['fontFamily'], string> = {
  sans: 'reader-font-sans-cjk',
  serif: 'reader-font-source-serif',
  song: 'reader-font-song',
  wenkai: 'reader-font-wenkai',
};
