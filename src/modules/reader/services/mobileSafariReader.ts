export interface MobileSafariReaderEnvironment {
  hasCoarsePointer: boolean;
  isStandalone: boolean;
  maxTouchPoints: number;
  userAgent: string;
  vendor: string;
  viewportWidth: number;
}

/**
 * Touch browsers are much more reliable when the document owns vertical
 * scrolling. A fixed `100dvh` overflow container can stop accepting pan
 * gestures after the browser toolbar resizes, orientation changes, or late
 * content (notably EPUB illustrations) changes its height.
 */
export function shouldUseMobileDocumentScroll(environment: MobileSafariReaderEnvironment): boolean {
  if (!environment.hasCoarsePointer || environment.maxTouchPoints <= 0) {
    return false;
  }

  const isAppleTouchDevice = /iPhone|iPad|iPod/.test(environment.userAgent)
    || (/Macintosh/.test(environment.userAgent) && environment.maxTouchPoints > 1);
  if (isAppleTouchDevice && environment.vendor === 'Apple Computer, Inc.') {
    // Every iOS/iPadOS browser uses WebKit, including standalone/PWA mode.
    return true;
  }

  // Android phones and tablets benefit from the same native scroll path.
  // The width guard avoids changing hybrid desktop/tablet PCs.
  return environment.viewportWidth <= 1366;
}

export function getMobileSafariReaderEnvironment(): MobileSafariReaderEnvironment {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return {
    hasCoarsePointer: window.matchMedia('(pointer: coarse)').matches,
    isStandalone: Boolean(navigatorWithStandalone.standalone) || window.matchMedia('(display-mode: standalone)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
    userAgent: navigator.userAgent,
    vendor: navigator.vendor,
    viewportWidth: window.innerWidth,
  };
}
