import { NavLink } from 'react-router-dom';
import { PRODUCT_NAME } from '../../config/product';
import { MAIN_NAV_ITEMS, SIDEBAR_BOTTOM_NAV_ITEMS } from '../../config/nav';
import { cn } from '../utils/cn';
import { BrandMark } from './BrandMark';
import { BrandWordmark } from './BrandWordmark';
import { isLegacyDesktopShell } from '../desktopShell';

export function Sidebar() {
  const legacyDesktopShell = isLegacyDesktopShell();

  if (legacyDesktopShell) {
    return <LegacySidebar />;
  }

  return (
    <aside className="app-sidebar fixed bottom-4 top-4 z-30 hidden w-[8rem] shrink-0 flex-col bg-paper/[0.78] p-3 backdrop-blur-2xl dark:bg-night-surface/[0.82] lg:flex">
      <NavLink className="flex flex-col items-center gap-2 rounded-2xl px-2 py-3 text-center group" to="/">
        <BrandWordmark className={cn(legacyDesktopShell ? 'gap-2' : 'flex-col gap-2', 'transition-transform duration-500 group-hover:-translate-y-0.5')} />
      </NavLink>

      <nav className="mt-6 min-h-0 space-y-2 overflow-y-auto overscroll-contain reader-scrollbar" aria-label="主导航">
        {MAIN_NAV_ITEMS.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              className={({ isActive }) =>
                cn(
                  'flex w-full flex-col items-center gap-1.5 rounded-2xl px-2 py-3 text-xs transition-all',
                  isActive
                    ? 'bg-accent/10 text-accent dark:bg-accent/15 dark:text-accent-soft'
                    : 'text-ink/65 hover:bg-white/45 hover:text-ink dark:text-stone-400 dark:hover:bg-white/[0.06] dark:hover:text-night-ink',
                )
              }
              end={item.path === '/'}
              key={item.path}
              to={item.path}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
      <nav className="mt-auto space-y-2 pt-5" aria-label="账户与工具">
        {SIDEBAR_BOTTOM_NAV_ITEMS.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              className={({ isActive }) =>
                cn(
                  'relative flex w-full flex-col items-center gap-1.5 rounded-2xl px-2 py-3 text-xs transition-all',
                  isActive
                    ? 'border border-accent/65 bg-accent/[0.08] text-accent dark:border-accent-soft/55 dark:bg-accent/10 dark:text-accent-soft'
                    : 'text-ink/65 hover:bg-white/45 hover:text-ink dark:text-stone-400 dark:hover:bg-white/[0.06] dark:hover:text-night-ink',
                )
              }
              key={item.path}
              to={item.path}
            >
              {({ isActive }) => (
                <>
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                  {isActive && <NavLinkIndicator />}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}

function LegacySidebar() {
  const items = [...MAIN_NAV_ITEMS, ...SIDEBAR_BOTTOM_NAV_ITEMS];

  return (
    <aside className="app-sidebar fixed bottom-4 top-4 z-30 hidden w-[7.75rem] shrink-0 flex-col border-r border-ink/[0.08] pr-3 dark:border-white/[0.08] lg:flex">
      <NavLink aria-label={PRODUCT_NAME} className="group flex items-center gap-2 rounded-lg py-1" to="/">
        <BrandMark className="h-7 w-7 text-accent transition-transform duration-200 group-hover:-translate-y-0.5" compact />
        <span className="whitespace-nowrap font-display text-sm font-semibold tracking-wide text-ink dark:text-night-ink">{PRODUCT_NAME}</span>
      </NavLink>
      <nav className="mt-5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain pb-1 reader-scrollbar" aria-label="主导航">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <NavLink
              className={({ isActive }) =>
                cn(
                  'sidebar-link flex min-h-9 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-[13px] transition-colors duration-150',
                  index === MAIN_NAV_ITEMS.length && 'mt-auto',
                  isActive
                    ? 'bg-accent/[0.08] font-semibold text-accent dark:bg-accent/15 dark:text-accent-soft'
                    : 'text-ink/60 hover:bg-white/65 hover:text-ink dark:text-stone-400 dark:hover:bg-white/[0.05] dark:hover:text-night-ink',
                )
              }
              end={item.path === '/'}
              key={item.path}
              to={item.path}
            >
              <Icon aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.7} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}

function NavLinkIndicator() {
  return <span aria-hidden="true" className="absolute right-2 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-accent dark:bg-accent-soft" />;
}
