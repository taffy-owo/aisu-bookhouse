import { Link, Outlet, useLocation } from 'react-router-dom';
import { Moon, Settings, Sun } from 'lucide-react';
import { ROUTES } from '../config/routes';
import { BrandWordmark, ErrorBoundary, MobileBottomNav, SakuraBackground, Sidebar, TopBar, UserAvatar } from '../shared/components';
import { useSession } from './SessionContext';
import { useTheme } from '../shared/theme';
import { HAIRLINE } from '../shared/ui';
import { cn } from '../shared/utils/cn';
import { createLocationResetKey } from './locationResetKey';
import { isLegacyDesktopShell } from '../shared/desktopShell';

export function AppLayout() {
  const location = useLocation();
  const resetKey = createLocationResetKey(location);
  const isHome = location.pathname === ROUTES.home;
  const isLibrary = location.pathname === ROUTES.library;
  const legacyDesktopShell = isLegacyDesktopShell();
  const shellLayoutClass = legacyDesktopShell
    ? 'mx-auto min-h-screen w-full max-w-[1800px] px-4 py-3 pb-28 sm:px-5 sm:pt-3 lg:px-5 lg:pb-10'
    : 'mx-auto min-h-screen w-full max-w-[1500px] px-3 py-3 pb-24 sm:px-4 sm:pt-4 md:px-6 lg:pb-8';
  const mainLayoutClass = legacyDesktopShell ? 'min-w-0 overflow-x-clip lg:pl-[9rem]' : 'min-w-0 overflow-x-clip lg:pl-[9.25rem]';

  return (
    <div className={cn('relative min-h-screen overflow-x-clip bg-paper font-sans text-ink antialiased dark:bg-night dark:text-night-copy', legacyDesktopShell && 'desktop-shell-legacy')}>
      <div className="app-ambient pointer-events-none fixed inset-0 z-0" />
      <SakuraBackground className={cn('pointer-events-none fixed inset-0 z-0 h-full w-full', isHome ? 'opacity-40 dark:opacity-35' : isLibrary ? 'opacity-20 dark:opacity-15' : 'opacity-10 dark:opacity-[0.08]')} count={isHome ? 12 : 6} />
      <div aria-hidden className={cn('grain pointer-events-none fixed inset-0 z-0', !isHome && 'opacity-40')} />

      <div className="relative z-10">
        <div className={cn('app-shell-content', shellLayoutClass)}>
          <Sidebar />
          <main className={mainLayoutClass}>
            <MobileBrandBar />
            <TopBar />
            <div className={cn('app-content', legacyDesktopShell ? 'mt-4 sm:mt-5 lg:mt-3' : 'mt-5 sm:mt-6 lg:mt-3')}>
              <ErrorBoundary resetKey={resetKey}>
                <div className="page-transition" key={location.pathname}>
                  <Outlet />
                </div>
              </ErrorBoundary>
            </div>
          </main>
        </div>
        <MobileBottomNav />
      </div>
    </div>
  );
}

function MobileBrandBar() {
  const { theme, toggleTheme } = useTheme();
  const { session } = useSession();

  return (
    <div className={cn('mobile-brand-bar mb-3 flex w-full max-w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b pb-3 lg:hidden', HAIRLINE)}>
      <div className="flex shrink-0 items-center gap-2.5">
        <BrandWordmark compact />
      </div>
      <div className="mobile-brand-actions ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
        <button
          aria-label={theme === 'dark' ? '切换浅色模式' : '切换夜间模式'}
          className="grid h-10 w-10 place-items-center rounded-full border border-ink/10 bg-white/45 text-ink/65 dark:border-white/10 dark:bg-white/[0.06] dark:text-night-soft"
          onClick={toggleTheme}
          type="button"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <Link
          aria-label="设置"
          className="grid h-10 w-10 place-items-center rounded-full border border-ink/10 bg-white/45 text-ink/65 transition hover:text-accent dark:border-white/10 dark:bg-white/[0.06] dark:text-night-soft"
          to={ROUTES.settings}
        >
          <Settings className="h-4 w-4" />
        </Link>
        <Link
          aria-label="个人中心"
          className="grid h-10 w-10 place-items-center rounded-full"
          to={ROUTES.profile}
        >
          <UserAvatar className="mobile-brand-avatar h-10 w-10" name={session?.nickname ?? '爱素'} role={session?.role} size="sm" userId={session?.id} avatar={session?.avatar} />
        </Link>
      </div>
    </div>
  );
}
