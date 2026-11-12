import { ChevronRight, LogOut, Moon, Search, Settings, Shield, Sun, UserRound, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../../app/SessionContext';
import { ROUTES } from '../../config/routes';
import { formatAccountCode } from '../../modules/auth/services/accountCode';
import { SourceUpdateNotifications } from '../../modules/books/components/SourceUpdateNotifications';
import { useTheme } from '../theme';
import { UserAvatar } from './UserAvatar';

interface TopBarProps {
  onSearchChange?: (value: string) => void;
  searchValue?: string;
}

export function TopBar({ onSearchChange, searchValue = '' }: TopBarProps) {
  const sessionContext = useSession();
  const { session } = sessionContext;
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [currentSearchValue, setCurrentSearchValue] = useState(searchValue);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCurrentSearchValue(urlQuery);
  }, [location.pathname, urlQuery]);

  const accountRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setIsAccountOpen(false); }, [location.key, session?.id]);

  useLayoutEffect(() => {
    if (!isAccountOpen) return;
    const panel = accountRef.current?.querySelector<HTMLElement>('#account-popover');
    const trigger = accountTriggerRef.current;
    if (!panel || !trigger) return;

    const updateHeight = () => {
      if (!trigger.getClientRects().length) {
        setIsAccountOpen(false);
        return;
      }
      const viewport = window.visualViewport;
      const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
      panel.style.maxHeight = `${Math.max(0, bottom - panel.getBoundingClientRect().top - 8)}px`;
    };
    updateHeight();
    // A short viewport may initially show only the account summary. Start at
    // the dialog so Tab scrolls its next action into view instead of focusing
    // an offscreen link while leaving the summary at the top.
    panel.focus({ preventScroll: true });
    window.addEventListener('resize', updateHeight);
    window.addEventListener('scroll', updateHeight, true);
    window.visualViewport?.addEventListener('resize', updateHeight);
    window.visualViewport?.addEventListener('scroll', updateHeight);
    return () => {
      window.removeEventListener('resize', updateHeight);
      window.removeEventListener('scroll', updateHeight, true);
      window.visualViewport?.removeEventListener('resize', updateHeight);
      window.visualViewport?.removeEventListener('scroll', updateHeight);
    };
  }, [isAccountOpen]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) {
        setIsAccountOpen(false);
      }
    }

    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };

    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && !event.defaultPrevented && accountRef.current?.querySelector('#account-popover')) {
        event.preventDefault();
        setIsAccountOpen(false);
        accountTriggerRef.current?.focus({ preventScroll: true });
      }
    }
  }, []);

  useEffect(() => {
    function handleSearchShortcut(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('[aria-modal="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }

    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, []);

  const handleSearchChange = (value: string) => {
    setCurrentSearchValue(value);
    onSearchChange?.(value);
  };

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitLibrarySearch(currentSearchValue);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }

    event.preventDefault();
    submitLibrarySearch(event.currentTarget.value);
  };

  const submitLibrarySearch = (rawQuery: string) => {
    setCurrentSearchValue(rawQuery.trim());
    navigateToLibrarySearch(rawQuery);
    // Release the software keyboard so the submitted results have room.
    // Clearing the query deliberately keeps focus for the next search.
    if (window.matchMedia('(pointer: coarse)').matches) searchInputRef.current?.blur();
  };

  const navigateToLibrarySearch = (rawQuery: string) => {
    const query = rawQuery.trim();
    const currentPath = location.pathname;
    const targetRoute = currentPath === ROUTES.japanese ? ROUTES.japanese
      : currentPath.startsWith(ROUTES.publicLibrary) ? ROUTES.publicLibrary : ROUTES.library;
    const next = currentPath === targetRoute ? new URLSearchParams(searchParams) : new URLSearchParams();
    if (query) next.set('q', query);
    else next.delete('q');
    const search = next.toString();
    // Repeated Enter must not add a Back step or reset the result position.
    if (currentPath === targetRoute && search === searchParams.toString()) return;
    navigate({ pathname: targetRoute, search });
  };

  return (
    <header className="topbar-shell relative z-30 w-full min-w-0 items-center gap-2 px-0 py-1.5 sm:gap-3 sm:py-3">
      <form aria-label="全站搜索" className="topbar-search-form relative min-w-0 flex-1" onSubmit={handleSearchSubmit}>
        <label>
          <Search className="topbar-search-icon pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400 sm:left-4" />
          <input
            aria-label="搜索书名、作者"
            enterKeyHint="search"
            className="topbar-search-input h-10 w-full border-0 border-b border-ink/15 bg-transparent pl-9 pr-12 text-base text-ink outline-none transition duration-300 placeholder:text-ink/60 focus:border-accent/65 focus:bg-transparent focus:shadow-none dark:border-white/15 dark:bg-transparent dark:text-night-copy dark:placeholder:text-stone-400 dark:focus:bg-transparent sm:h-11 sm:pl-11 sm:pr-24 sm:text-sm"
            onChange={(event) => handleSearchChange(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={location.pathname === ROUTES.japanese ? '搜索日文书名、作者' : '搜索书名、作者'}
            ref={searchInputRef}
            value={currentSearchValue}
          />
          {currentSearchValue && <button
            aria-label="清除搜索"
            className="topbar-search-clear absolute right-0 top-1/2 grid h-10 w-11 -translate-y-1/2 place-items-center text-stone-500 transition hover:text-accent sm:right-14 dark:text-stone-400"
            onClick={() => {
              handleSearchChange('');
              if (urlQuery) navigateToLibrarySearch('');
              searchInputRef.current?.focus();
            }}
            type="button"
          ><X className="h-4 w-4" /></button>}
          <kbd className="topbar-search-shortcut pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 px-0 py-0.5 font-mono text-[10px] font-medium text-ink/45 sm:inline-flex dark:text-stone-400">
            Ctrl K
          </kbd>
        </label>
      </form>
      <button
        aria-label={theme === 'dark' ? '切换浅色模式' : '切换夜间模式'}
        className="topbar-theme-toggle ml-auto grid h-9 w-9 shrink-0 place-items-center text-ink/60 transition duration-300 hover:text-accent dark:text-night-soft dark:hover:text-accent-soft sm:h-11 sm:w-11"
        onClick={toggleTheme}
        type="button"
      >
        {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </button>
      <SourceUpdateNotifications sessionId={session?.id} />
      <div className="relative shrink-0" ref={accountRef} onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const firstAction = accountRef.current?.querySelector('#account-popover a[href], #account-popover button:not([disabled])');
        if (event.key === 'Tab' && event.shiftKey && (event.target === firstAction || (event.target as HTMLElement).id === 'account-popover')) {
          event.preventDefault();
          setIsAccountOpen(false);
          accountTriggerRef.current?.focus({ preventScroll: true });
        }
      }} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsAccountOpen(false);
      }}>
        <button
          ref={accountTriggerRef}
          aria-label="用户菜单"
          aria-expanded={isAccountOpen}
          aria-haspopup="dialog"
          aria-controls={isAccountOpen ? 'account-popover' : undefined}
          className="topbar-account-toggle group relative flex h-9 shrink-0 items-center gap-2 overflow-visible p-0.5 pr-0 transition duration-300 active:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 sm:h-11 sm:pr-0"
          onClick={() => setIsAccountOpen((isOpen) => !isOpen)}
          type="button"
        >
          <UserAvatar className="topbar-avatar h-8 w-8 shrink-0 ring-0 sm:h-10 sm:w-10" name={session?.nickname ?? '爱素'} role={session?.role} size="md" userId={session?.id} avatar={session?.avatar} />
          <span className="topbar-account-name hidden max-w-28 truncate text-xs font-medium text-ink/65 dark:text-night-soft xl:block">{session?.nickname ?? '我的'}</span>
        </button>
        {isAccountOpen && (
          <AccountPopover
            navigateToLogin={() => navigate(ROUTES.login)}
            onClose={() => setIsAccountOpen(false)}
            sessionContext={sessionContext}
          />
        )}
      </div>
    </header>
  );
}

function AccountPopover({
  navigateToLogin,
  onClose,
  sessionContext,
}: {
  navigateToLogin: () => void;
  onClose: () => void;
  sessionContext: ReturnType<typeof useSession>;
}) {
  const { logout, session } = sessionContext;

  if (!session) {
    return (
      <div id="account-popover" role="dialog" aria-label="用户菜单" tabIndex={-1} className="account-popover absolute right-0 top-[calc(100%+8px)] z-30 max-h-[calc(100dvh-5rem)] w-[280px] max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-[24px] bg-shell p-2 shadow-[0_24px_80px_rgba(28,25,23,0.18)] reader-scrollbar dark:bg-night-surface dark:shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
        <div className="px-3 py-3">
          <p className="text-sm font-semibold text-stone-900 dark:text-night-ink">未登录</p>
          <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">登录后可以浏览公共书库，并继续阅读和管理自己的书架。</p>
        </div>
        <button
          className="flex min-h-11 w-full items-center justify-center rounded-[20px] bg-accent-strong px-4 text-sm font-semibold text-white transition hover:bg-accent-deep"
          onClick={() => {
            onClose();
            navigateToLogin();
          }}
          type="button"
        >
          去登录
        </button>
      </div>
    );
  }

  const statusLabel = getStatusLabel(session?.status);
  const roleLabel = session?.role === 'admin' ? '管理员' : '普通用户';

  return (
    <div id="account-popover" role="dialog" aria-label="用户菜单" tabIndex={-1} className="account-popover absolute right-0 top-[calc(100%+8px)] z-30 max-h-[calc(100dvh-5rem)] w-[350px] max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-[28px] bg-shell shadow-[0_24px_80px_rgba(28,25,23,0.18)] reader-scrollbar dark:bg-night-surface dark:shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
      {/* 1. Header user card */}
      <div className="account-popover-header relative overflow-hidden border-b border-stone-200/40 bg-gradient-to-br from-sakura via-shell to-paper px-5 py-5 dark:border-stone-800/40 dark:from-[#3A272C] dark:via-[#251F20] dark:to-night-surface">
        <div className="pointer-events-none absolute -left-10 -top-14 h-36 w-36 rounded-full bg-accent/20 blur-3xl" />
        <div className="pointer-events-none absolute -right-10 -top-14 h-36 w-36 rounded-full bg-peach/40 blur-3xl" />

        <div className="account-popover-summary relative flex items-center gap-4">
          <div className="shrink-0 select-none">
            <UserAvatar 
              className="account-popover-avatar rounded-full ring-4 ring-white/80 dark:ring-[#251F20]"
              name={session?.nickname ?? '爱素'} 
              role={session?.role} 
              size="xl" 
              userId={session?.id} 
              avatar={session?.avatar} 
            />
          </div>

          <div className="min-w-0 flex-1">
            <p title={session.nickname} className="truncate font-display text-lg font-semibold text-stone-950 dark:text-night-ink">
              {session?.nickname ?? '未登录'}
            </p>
            <div className="account-popover-identity mt-0.5 flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
              <span className="truncate" title={session?.email ?? '请先登录'}>{session?.email ?? '请先登录'}</span>
              {session && (
                <span className="shrink-0 font-mono text-stone-400/80 dark:text-stone-500/80">
                  {formatAccountCode(session.accountNumber, session.id)}
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent dark:text-accent-soft">
                {roleLabel}
              </span>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                {statusLabel}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 2. Menu Navigation Links */}
      <div className="account-popover-links p-2 space-y-1 bg-shell/40 dark:bg-white/[0.01]">
        <Link
          className="flex items-center justify-between gap-3 rounded-[20px] p-3 text-left transition hover:bg-stone-100/70 dark:hover:bg-white/[0.06] group"
          onClick={onClose}
          to={ROUTES.profile}
        >
          <span className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-sakura text-accent dark:bg-plum/50 group-hover:scale-105 transition-transform duration-300">
              <UserRound className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-stone-900 dark:text-night-ink">个人中心</span>
              <span className="mt-0.5 block text-xs text-stone-400 dark:text-stone-500">修改头像、昵称与账号属性</span>
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-stone-400 group-hover:translate-x-0.5 transition-transform duration-300" />
        </Link>

        <Link
          className="flex items-center justify-between gap-3 rounded-[20px] p-3 text-left transition hover:bg-stone-100/70 dark:hover:bg-white/[0.06] group"
          onClick={onClose}
          to={ROUTES.settings}
        >
          <span className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-sakura text-accent dark:bg-plum/50 group-hover:scale-105 transition-transform duration-300">
              <Settings className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-stone-900 dark:text-night-ink">系统设置</span>
              <span className="mt-0.5 block text-xs text-stone-400 dark:text-stone-500">调整主题外观与查看部署状态</span>
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-stone-400 group-hover:translate-x-0.5 transition-transform duration-300" />
        </Link>

        {session?.role === 'admin' && (
          <Link
            className="flex items-center justify-between gap-3 rounded-[20px] p-3 text-left transition hover:bg-stone-100/70 dark:hover:bg-white/[0.06] group"
            onClick={onClose}
            to={ROUTES.adminUsers}
          >
            <span className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-sakura text-accent dark:bg-plum/50 group-hover:scale-105 transition-transform duration-300">
                <Shield className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-stone-900 dark:text-night-ink">用户管理</span>
                <span className="mt-0.5 block text-xs text-stone-400 dark:text-stone-500">查看账号身份并管理用户状态</span>
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-stone-400 group-hover:translate-x-0.5 transition-transform duration-300" />
          </Link>
        )}
      </div>

      {/* 3. Safety/Exit Area */}
      <div className="border-t border-stone-200/40 bg-stone-50/70 p-2 dark:border-stone-800/40 dark:bg-black/10">
        <button
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[20px] text-sm font-semibold text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 transition duration-200"
          onClick={async () => {
            onClose();
            await logout();
            navigateToLogin();
          }}
          type="button"
        >
          <LogOut className="h-4 w-4" />
          退出登录
        </button>
      </div>
    </div>
  );
}

function getStatusLabel(status?: string) {
  if (status === 'active') {
    return '正常';
  }

  if (status === 'disabled') {
    return '已停用';
  }

  return status ?? '暂无';
}
