import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeContext, type Theme } from './ThemeContext';

interface ThemeProviderProps {
  children: ReactNode;
}

const LOCAL_STORAGE_KEY = 'aisu-theme';

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => getInitialTheme());

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
    saveStoredTheme(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((currentTheme) => {
      const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
      saveStoredTheme(nextTheme);
      return nextTheme;
    });
  }, []);

  useLayoutEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1A1320' : '#E6DCD7');
  }, [theme]);

  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (event.key === LOCAL_STORAGE_KEY || event.key === null) {
        setThemeState(getInitialTheme());
      }
    };
    window.addEventListener('storage', syncTheme);
    return () => window.removeEventListener('storage', syncTheme);
  }, []);

  const value = useMemo(() => ({ setTheme, theme, toggleTheme }), [setTheme, theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function getInitialTheme(): Theme {
  return getStoredTheme() ?? 'dark';
}

function getStoredTheme(): Theme | null {
  const savedTheme = safelyReadStoredTheme();

  return isTheme(savedTheme) ? savedTheme : null;
}

function saveStoredTheme(theme: Theme): void {
  try {
    if (canUseLocalStorage()) {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, theme);
    }
  } catch {
    // Browsers can deny localStorage in private or hardened modes. Theme still works for this session.
  }
}

function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'light';
}

function safelyReadStoredTheme(): string | null {
  try {
    if (canUseLocalStorage()) {
      return window.localStorage.getItem(LOCAL_STORAGE_KEY);
    }
  } catch {
    return null;
  }

  return null;
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
  } catch {
    return false;
  }
}
