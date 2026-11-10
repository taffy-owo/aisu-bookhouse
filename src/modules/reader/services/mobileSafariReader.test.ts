import { describe, expect, it } from 'vitest';
import { shouldUseMobileDocumentScroll } from './mobileSafariReader';

describe('shouldUseMobileDocumentScroll', () => {
  it('uses document scrolling in iPhone Safari tabs', () => {
    expect(shouldUseMobileDocumentScroll({
      hasCoarsePointer: true,
      isStandalone: false,
      maxTouchPoints: 5,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      vendor: 'Apple Computer, Inc.',
      viewportWidth: 390,
    })).toBe(true);
  });

  it('supports iPad Safari using a desktop-class user agent', () => {
    expect(shouldUseMobileDocumentScroll({
      hasCoarsePointer: true,
      isStandalone: false,
      maxTouchPoints: 5,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
      vendor: 'Apple Computer, Inc.',
      viewportWidth: 1024,
    })).toBe(true);
  });

  it('uses document scrolling in iOS Chrome and standalone mode too', () => {
    const iosChrome = {
      hasCoarsePointer: true,
      isStandalone: true,
      maxTouchPoints: 5,
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1',
      vendor: 'Apple Computer, Inc.',
      viewportWidth: 390,
    };
    expect(shouldUseMobileDocumentScroll(iosChrome)).toBe(true);
    expect(shouldUseMobileDocumentScroll({ ...iosChrome, isStandalone: false })).toBe(true);
  });

  it('uses native scrolling on Android touch screens but not desktop pointers', () => {
    const android = {
      hasCoarsePointer: true,
      isStandalone: false,
      maxTouchPoints: 5,
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
      vendor: 'Google Inc.',
      viewportWidth: 412,
    };
    expect(shouldUseMobileDocumentScroll(android)).toBe(true);
    expect(shouldUseMobileDocumentScroll({ ...android, hasCoarsePointer: false, maxTouchPoints: 0, viewportWidth: 1920 })).toBe(false);
  });
});
