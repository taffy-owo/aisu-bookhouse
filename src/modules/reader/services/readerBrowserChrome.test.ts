import { describe, expect, it } from 'vitest';
import { getReaderBrowserChromeTheme } from './readerBrowserChrome';

describe('readerBrowserChrome', () => {
  it('uses the reader shell color and dark browser controls at night', () => {
    expect(getReaderBrowserChromeTheme('dark')).toEqual({ colorScheme: 'dark', themeColor: '#10131a' });
  });

  it.each([
    ['paper', '#c1b296'],
    ['green', '#9fa99d'],
    ['white', '#dcddda'],
  ] as const)('matches the %s reader shell', (theme, themeColor) => {
    expect(getReaderBrowserChromeTheme(theme)).toEqual({ colorScheme: 'light', themeColor });
  });
});
