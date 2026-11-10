import type { ReaderTheme } from '../types/reader';

type BrowserChromeTheme = {
  colorScheme: 'dark' | 'light';
  themeColor: string;
};

const browserChromeThemes: Record<ReaderTheme, BrowserChromeTheme> = {
  dark: { colorScheme: 'dark', themeColor: '#10131a' },
  green: { colorScheme: 'light', themeColor: '#9fa99d' },
  paper: { colorScheme: 'light', themeColor: '#c1b296' },
  white: { colorScheme: 'light', themeColor: '#dcddda' },
};

export function getReaderBrowserChromeTheme(theme: ReaderTheme): BrowserChromeTheme {
  return browserChromeThemes[theme];
}

export function applyReaderBrowserChromeTheme(theme: ReaderTheme): () => void {
  const { colorScheme, themeColor } = getReaderBrowserChromeTheme(theme);
  const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const statusBarMeta = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]');
  const previousThemeColor = themeColorMeta?.content;
  const previousStatusBarStyle = statusBarMeta?.content;
  const previousHtmlBackground = document.documentElement.style.backgroundColor;
  const previousBodyBackground = document.body.style.backgroundColor;
  const previousHtmlColorScheme = document.documentElement.style.colorScheme;
  const previousBodyColorScheme = document.body.style.colorScheme;

  if (themeColorMeta) themeColorMeta.content = themeColor;
  if (statusBarMeta) statusBarMeta.content = colorScheme === 'dark' ? 'black-translucent' : 'default';
  document.documentElement.style.backgroundColor = themeColor;
  document.body.style.backgroundColor = themeColor;
  document.documentElement.style.colorScheme = colorScheme;
  document.body.style.colorScheme = colorScheme;

  return () => {
    if (themeColorMeta && previousThemeColor !== undefined) themeColorMeta.content = previousThemeColor;
    if (statusBarMeta && previousStatusBarStyle !== undefined) statusBarMeta.content = previousStatusBarStyle;
    restoreInlineStyle(document.documentElement, 'background-color', previousHtmlBackground);
    restoreInlineStyle(document.body, 'background-color', previousBodyBackground);
    restoreInlineStyle(document.documentElement, 'color-scheme', previousHtmlColorScheme);
    restoreInlineStyle(document.body, 'color-scheme', previousBodyColorScheme);
  };
}

function restoreInlineStyle(element: HTMLElement, property: string, value: string): void {
  if (value) {
    element.style.setProperty(property, value);
  } else {
    element.style.removeProperty(property);
  }
}
