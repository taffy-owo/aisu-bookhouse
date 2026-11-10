import { useLayoutEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { MOBILE_NAV_ITEMS } from '../../config/nav';
import { cn } from '../utils/cn';

export function MobileBottomNav() {
  const navRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const root = document.documentElement;
    let frame = 0;
    let previousSpace = '';
    const update = () => {
      frame = 0;
      const height = nav.getBoundingClientRect().height;
      const bottom = Number.parseFloat(getComputedStyle(nav).bottom) || 0;
      const space = `${height ? Math.ceil(height + bottom + 16) : 0}px`;
      if (space !== previousSpace) {
        previousSpace = space;
        root.style.setProperty('--app-mobile-nav-space', space);
      }
    };
    // Font size, orientation and safe areas can all change the space needed
    // after the last page action. Coalesce observer writes outside its callback.
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(nav);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    update();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      root.style.removeProperty('--app-mobile-nav-space');
    };
  }, []);

  return (
    <nav
      ref={navRef}
      aria-label="主要导航"
      className="mobile-bottom-nav fixed z-30 grid border border-hairline bg-paper/90 shadow-dusk-sm backdrop-blur-2xl lg:hidden dark:border-white/10 dark:bg-night-surface/90"
      style={{ gridTemplateColumns: `repeat(${MOBILE_NAV_ITEMS.length}, minmax(0, 1fr))` }}
    >
      {MOBILE_NAV_ITEMS.map((item) => {
        const Icon = item.icon;

        return (
          <NavLink
            className={({ isActive }) =>
              cn(
                'flex min-w-0 flex-col items-center',
                isActive ? 'bg-accent/10 text-accent dark:bg-accent/15 dark:text-accent-soft' : 'text-ink/55 dark:text-stone-400',
              )
            }
            end={item.path === '/'}
            key={item.path}
            to={item.path}
          >
            <Icon className="h-4 w-4" />
            <span className="max-w-full truncate">{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
