import { getBookProgressLabel, hasBookReadingHistory } from '../../books/services/bookProgress';
import { ArrowRight, Camera, Check, CheckCircle2, Copy, Edit2, Loader2, LogOut, Play, Plus, Settings, ShieldCheck, UploadCloud, UserRound, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { useSession } from '../../../app/SessionContext';
import { ROUTES, getBookDetailPath } from '../../../config/routes';
import { Button } from '../../../shared/components/Button';
import { LinkButton } from '../../../shared/components/LinkButton';
import { Panel } from '../../../shared/components/Panel';
import { ProgressBar } from '../../../shared/components/ProgressBar';
import { UserAvatar } from '../../../shared/components/UserAvatar';
import { HAIRLINE, LABEL } from '../../../shared/ui';
import { cn } from '../../../shared/utils/cn';
import { isAbortError } from '../../../shared/utils/abortError';
import { formatFileSize } from '../../../shared/utils/formatFileSize';
import { BookCover, getBrowserReaderAvailability, getBookshelfOverview, invalidateBookListCache, type Book, type BookShelfOverview } from '../../books';
import { formatAccountCode } from '../../auth';
import { SectionHeader } from '../../library/components/SectionHeader';
import { createInvitation, getInvitationQuota, type InvitationQuota } from '../../settings/services/invitationService';
import { getUploadStatusMeta, getUploadTasks } from '../../uploads/services/uploadService';
import type { UploadTask } from '../../uploads/types/upload';
import { ReadingAnalyticsPanel } from '../components/ReadingAnalyticsPanel';
import { ProfileResourceFeedback } from '../components/ProfileResourceFeedback';
import { useProfileResource, type ProfileResource } from '../hooks/useProfileResource';
import { getAvatarUploadError } from '../services/avatarUploadErrors';
import { READING_PROGRESS_SAVED_EVENT } from '../../reading-progress';
import { TRANSLATED_BOOKS_CHANGED_EVENT } from '../../uploads/services/wholeBookTranslationService';
import { startPolling } from '../../../shared/utils/polling';

const loadProfileShelf = (signal: AbortSignal) => {
  invalidateBookListCache();
  return getBookshelfOverview(true, signal);
};

function revealProfileControl(element: HTMLElement | null, restoreFocus = false) {
  if (!element?.getClientRects().length) return;
  // An async save may finish after the reader has moved to another section.
  if (restoreFocus && (element.closest('[data-active]')?.getAttribute('data-active') === 'false'
    || (document.activeElement !== document.body && document.activeElement !== element))) return;
  if (restoreFocus) element.focus({ preventScroll: true });
  const bounds = element.getBoundingClientRect();
  const bottomInset = window.innerWidth < 1024 ? 96 : 24;
  if (bounds.top < 80 || bounds.bottom > window.innerHeight - bottomInset) {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}

export function ProfilePage() {
  const { logout, session } = useSession();
  const [activeProfileSection, setActiveProfileSection] = useState<'reading' | 'account'>('reading');
  const sectionId = useId();
  const shelfResource = useProfileResource(session?.id, loadProfileShelf);
  const refreshShelf = shelfResource.retry;
  useEffect(() => startPolling(refreshShelf, {
    immediate: false,
    events: ['focus', READING_PROGRESS_SAVED_EVENT, TRANSLATED_BOOKS_CHANGED_EVENT],
  }), [refreshShelf]);
  const uploadsResource = useProfileResource(session?.id, getUploadTasks);
  const invitationResource = useProfileResource(session?.id, getInvitationQuota);
  const bookshelfOverview = shelfResource.data;
  const invitationQuota = invitationResource.data;
  const books = bookshelfOverview?.books ?? [];
  const tasks = uploadsResource.data ?? [];
  const [invitationError, setInvitationError] = useState('');
  const [unconfirmedInvitationQuota, setUnconfirmedInvitationQuota] = useState<InvitationQuota | null>(null);
  const [isCreatingInvitation, setIsCreatingInvitation] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const invitationControllerRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const copyVersionRef = useRef(0);
  const copyPendingRef = useRef<number | null>(null);
  const profileEpochRef = useRef(0);

  useEffect(() => {
    const epoch = ++profileEpochRef.current;
    invitationControllerRef.current?.abort();
    invitationControllerRef.current = null;
    copyPendingRef.current = null;
    setUnconfirmedInvitationQuota(null);
    setInvitationError('');
    setIsCreatingInvitation(false);
    setCopyState('idle');

    return () => {
      invitationControllerRef.current?.abort();
      invitationControllerRef.current = null;
      copyPendingRef.current = null;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
      if (profileEpochRef.current === epoch) {
        profileEpochRef.current += 1;
      }
    };
  }, [session?.id]);

  const continueBook = bookshelfOverview?.continueBook ?? books[0];
  const completedUploads = tasks.filter((task) => task.status === 'ready').length;
  const invitation = invitationQuota?.invitation ?? null;
  const isInvitationUnconfirmed = unconfirmedInvitationQuota !== null && invitationQuota === unconfirmedInvitationQuota;
  useEffect(() => {
    // After a lost response, only a fresh successful quota read can verify
    // whether the previous code survived or a new code was committed.
    if (!unconfirmedInvitationQuota || !invitationQuota || invitationQuota === unconfirmedInvitationQuota
      || invitationResource.isLoading || invitationResource.error) return;
    if (invitationQuota.invitation?.id !== unconfirmedInvitationQuota.invitation?.id) setInvitationError('');
    setUnconfirmedInvitationQuota(null);
  }, [invitationQuota, unconfirmedInvitationQuota, invitationResource.isLoading, invitationResource.error]);
  useEffect(() => {
    copyVersionRef.current += 1;
    copyPendingRef.current = null;
    setCopyState('idle');
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
    return () => { copyVersionRef.current += 1; };
  }, [invitation?.id, invitation?.code, invitation?.status]);

  async function handleCopyInvitation() {
    if (!invitation?.code || invitation.status !== 'available') {
      return;
    }

    if (copyPendingRef.current !== null || invitationControllerRef.current || isInvitationUnconfirmed) return;
    const copyVersion = ++copyVersionRef.current;
    copyPendingRef.current = copyVersion;
    const epoch = profileEpochRef.current;
    setCopyState('copying');
    setInvitationError('');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(invitation.code);
      if (profileEpochRef.current !== epoch || copyVersionRef.current !== copyVersion) return;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      setCopyState('copied');
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        if (profileEpochRef.current === epoch && copyVersionRef.current === copyVersion) setCopyState('idle');
      }, 1400);
    } catch {
      if (profileEpochRef.current !== epoch || copyVersionRef.current !== copyVersion) return;
      setCopyState('idle');
      setInvitationError('复制失败，请选中上方邀请码手动复制。');
    } finally {
      if (copyPendingRef.current === copyVersion) copyPendingRef.current = null;
    }
  }

  async function handleCreateInvitation() {
    if (invitationControllerRef.current || isInvitationUnconfirmed || invitationResource.isLoading || invitationResource.error || !invitationQuota?.can_create) return;
    copyVersionRef.current += 1;
    copyPendingRef.current = null;
    setCopyState('idle');
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
    const epoch = profileEpochRef.current;
    const controller = new AbortController();
    invitationControllerRef.current = controller;
    setUnconfirmedInvitationQuota(invitationQuota);
    setIsCreatingInvitation(true);
    setInvitationError('');

    try {
      const created = await createInvitation(controller.signal);
      if (profileEpochRef.current !== epoch || controller.signal.aborted) return;
      setUnconfirmedInvitationQuota(null);
      invitationResource.replaceData({ invitation: created, can_create: false, remaining: invitationQuota?.remaining ?? null });
      invitationResource.retry();
    } catch (error) {
      if (controller.signal.aborted || profileEpochRef.current !== epoch) return;
      setInvitationError(error instanceof Error ? error.message : '邀请码生成失败');
      invitationResource.retry();
    } finally {
      if (invitationControllerRef.current === controller) {
        invitationControllerRef.current = null;
      }
      if (profileEpochRef.current === epoch && !controller.signal.aborted) {
        setIsCreatingInvitation(false);
      }
    }
  }

  return (
    <div className="profile-page space-y-8 lg:space-y-5" data-navigation-loading={shelfResource.isLoading}>
        <ProfileHero
          key={session?.id ?? 'anonymous'}
        book={continueBook}
        completedUploads={uploadsResource.data ? completedUploads : undefined}
        favoriteCount={bookshelfOverview?.favoriteCount}
        inProgressCount={bookshelfOverview?.inProgressCount}
        shelfResource={shelfResource}
        uploadsResource={uploadsResource}
        onLogout={logout}
        session={session}
        totalBooks={bookshelfOverview?.total}
      />

      <nav aria-label="个人中心分类" className="flex gap-2 xl:hidden">
        <button aria-controls={`${sectionId}-reading`} aria-pressed={activeProfileSection === 'reading'} className={`min-h-11 rounded-xl px-4 text-sm ${activeProfileSection === 'reading' ? 'bg-accent-strong text-white' : 'bg-stone-100 dark:bg-white/5'}`} onClick={() => setActiveProfileSection('reading')} type="button">阅读记录</button>
        <button aria-controls={`${sectionId}-account`} aria-pressed={activeProfileSection === 'account'} className={`min-h-11 rounded-xl px-4 text-sm ${activeProfileSection === 'account' ? 'bg-accent-strong text-white' : 'bg-stone-100 dark:bg-white/5'}`} onClick={() => setActiveProfileSection('account')} type="button">账号与邀请</button>
      </nav>
      <div className="grid min-w-0 gap-x-6 gap-y-8 lg:gap-y-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="profile-reading-section min-w-0 space-y-8 lg:space-y-5" id={`${sectionId}-reading`} data-active={activeProfileSection === 'reading'} onFocusCapture={() => setActiveProfileSection('reading')} onPointerDownCapture={() => setActiveProfileSection('reading')}>
          <ContinueReadingPanel book={continueBook} resource={shelfResource} />
          <ReadingAnalyticsPanel key={session?.id ?? 'anonymous'} accountId={session?.id} books={bookshelfOverview?.bookLabels ?? []} />
          <UploadOverviewPanel tasks={tasks} resource={uploadsResource} />
        </div>

        <aside className="profile-account-section min-w-0 space-y-8 lg:space-y-5" id={`${sectionId}-account`} data-active={activeProfileSection === 'account'} onFocusCapture={() => setActiveProfileSection('account')} onPointerDownCapture={() => setActiveProfileSection('account')}>
          <AccountPanel key={session?.id ?? 'anonymous'} onLogout={logout} session={session} />
          <InvitationOverviewPanel resource={invitationResource} copyState={copyState} errorMessage={invitationError} invitationQuota={invitationQuota} isCreating={isCreatingInvitation} isUnconfirmed={isInvitationUnconfirmed} onCopy={handleCopyInvitation} onCreate={handleCreateInvitation} />
          {session?.role === 'admin' && <AdminQuickPanel />}
        </aside>
      </div>
    </div>
  );
}

function ProfileHero({ book, completedUploads, favoriteCount, inProgressCount, onLogout, session, totalBooks, shelfResource, uploadsResource }: { book?: Book; completedUploads?: number; favoriteCount?: number; inProgressCount?: number; onLogout: () => void | Promise<void>; session: ReturnType<typeof useSession>['session']; totalBooks?: number; shelfResource: ProfileResource<BookShelfOverview>; uploadsResource: ProfileResource<UploadTask[]> }) {
  const navigationState = createCollectionLinkState(useLocation());
  const availability = book ? getBrowserReaderAvailability(book) : null;
  const { updateAvatar } = useSession();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarControllerRef = useRef<AbortController | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [avatarMessage, setAvatarMessage] = useState('');

  useEffect(() => () => {
    avatarControllerRef.current?.abort();
    avatarControllerRef.current = null;
  }, []);

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file || avatarControllerRef.current) return;
    setAvatarMessage('');
    if (file.size === 0 || (file.type && !file.type.startsWith('image/'))) {
      setUploadError(file.size === 0 ? '这张图片是空文件，请重新选择。' : '请选择图片文件作为头像。');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setUploadError('头像图片不能超过 5MB');
      return;
    }

    setIsUploading(true);
    setUploadError('');
    const controller = new AbortController();
    avatarControllerRef.current = controller;
    try {
      await updateAvatar(file, controller.signal);
      if (!controller.signal.aborted) setAvatarMessage('头像已更新');
    } catch (err) {
      if (!controller.signal.aborted && !isAbortError(err)) setUploadError(getAvatarUploadError(err));
    } finally {
      if (avatarControllerRef.current === controller) avatarControllerRef.current = null;
      if (!controller.signal.aborted) setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const stats = [
    { label: '藏书', to: ROUTES.library, value: totalBooks },
    { label: '在读', to: `${ROUTES.library}?kind=recent`, value: inProgressCount },
    { label: '收藏', to: `${ROUTES.library}?kind=favorite`, value: favoriteCount },
    { label: '上传完成', to: ROUTES.upload, value: completedUploads },
  ] as const;

  return (
    <Panel className={cn('profile-summary border-b pb-8', HAIRLINE)}>
      <div className="flex items-center gap-4 sm:gap-6">
        <div className="relative shrink-0 select-none">
          <button
            aria-label="更换头像"
            aria-busy={isUploading}
            className="group relative inline-flex rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            disabled={isUploading}
            onClick={handleAvatarClick}
            type="button"
          >
            <UserAvatar
              className="profile-avatar h-16 w-16 text-xl sm:h-20 sm:w-20 sm:text-2xl"
              name={session?.nickname ?? '爱素'}
              role={session?.role}
              size="xl"
              userId={session?.id}
              avatar={session?.avatar}
            />
            <div className={cn('absolute inset-0 z-20 flex flex-col items-center justify-center rounded-full bg-black/40 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100', isUploading ? 'opacity-100' : 'opacity-0')}>
              {isUploading ? (
                <Loader2 className="h-6 w-6 animate-spin text-white" />
              ) : (
                <Camera className="h-6 w-6 text-white" />
              )}
            </div>
            {!isUploading && <span aria-hidden className="absolute -bottom-0.5 -right-0.5 z-20 grid h-6 w-6 place-items-center rounded-full bg-paper text-accent shadow-sm dark:bg-night-surface dark:text-accent-soft"><Camera className="h-3 w-3" /></span>}
          </button>
          <input
            aria-label="头像图片"
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept="image/*"
            onChange={handleAvatarChange}
            disabled={isUploading}
          />

        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="app-page-title truncate font-display text-3xl font-semibold text-stone-900 sm:text-4xl dark:text-night-ink" title={session?.nickname ?? '未登录'}>{session?.nickname ?? '未登录'}</h1>
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent dark:text-accent-soft">
              <ShieldCheck className="h-3.5 w-3.5" />
              {session?.role === 'admin' ? '管理员' : '普通用户'}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/25 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {getStatusLabel(session?.status)}
            </span>
          </div>
          <p className="mt-1.5 truncate text-xs text-stone-500 dark:text-stone-400" title={session?.email ?? undefined}>{session?.email ?? ''}</p>
        </div>
      </div>

      {uploadError && <p className="mt-3 break-words text-xs text-red-600 dark:text-red-300" role="alert">{uploadError}</p>}
      {avatarMessage && <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300" role="status">{avatarMessage}</p>}
      <div className="mt-8 grid grid-cols-2 gap-y-8 lg:mt-5 lg:gap-y-5 md:grid-cols-4">
        {stats.map(({ label, to, value }) => (
          <Link aria-label={`${label} ${value === undefined ? '暂未取得数据' : value}`} aria-busy={label === '上传完成' ? uploadsResource.isLoading : shelfResource.isLoading} className="group border-l border-accent/25 pl-4 sm:pl-6" key={label} to={to}>
            <span className="block font-display text-4xl font-medium leading-none tabular-nums text-stone-950 transition-colors group-hover:text-accent sm:text-5xl lg:text-3xl dark:text-night-ink dark:group-hover:text-peach">
              {value ?? '—'}
            </span>
            <span className={cn('mt-3 block', LABEL)}>{label}</span>
          </Link>
        ))}
      </div>

      <ProfileResourceFeedback label="书架统计" error={shelfResource.error} isLoading={shelfResource.isLoading} hasData={Boolean(shelfResource.data)} onRetry={shelfResource.retry} />
      <div className="profile-actions mt-8 flex flex-wrap gap-2 sm:gap-3">
        {book && availability && (
          <LinkButton className="hidden sm:inline-flex" icon={availability.canReadInBrowser ? <Play className="h-4 w-4 fill-current" /> : <ArrowRight className="h-4 w-4" />} title={availability.reason} state={navigationState} to={availability.entryPath}>
            {availability.canReadInBrowser ? (hasBookReadingHistory(book) ? '继续阅读' : '开始阅读') : '查看详情'}
          </LinkButton>
        )}
        <LinkButton className="min-h-11 flex-1 whitespace-nowrap gap-1.5 px-2 text-[13px] sm:flex-none sm:gap-2 sm:px-4 sm:text-sm" icon={<UploadCloud className="h-4 w-4" />} to={ROUTES.upload} variant="secondary">
          上传书籍
        </LinkButton>
        <LinkButton className="min-h-11 flex-1 whitespace-nowrap gap-1.5 px-2 text-[13px] sm:flex-none sm:gap-2 sm:px-4 sm:text-sm" icon={<Settings className="h-4 w-4" />} to={ROUTES.settings} variant="secondary">
          系统设置
        </LinkButton>
        <Button className="min-h-11 flex-1 whitespace-nowrap gap-1.5 px-2 text-[13px] sm:flex-none sm:gap-2 sm:px-4 sm:text-sm" icon={<LogOut className="h-4 w-4" />} onClick={onLogout} variant="ghost">
          退出登录
        </Button>
      </div>
    </Panel>
  );
}

function ContinueReadingPanel({ book, resource }: { book?: Book; resource: ProfileResource<BookShelfOverview> }) {
  const navigationState = createCollectionLinkState(useLocation());
  const availability = book ? getBrowserReaderAvailability(book) : null;
  return (
    <Panel>
      <SectionHeader
        action={
          <Link className="inline-flex min-h-10 items-center gap-1 text-sm text-stone-400 hover:text-accent dark:text-stone-500 dark:hover:text-accent-soft" to={ROUTES.library}>
            全部书籍 <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
        title="继续阅读"
      />
      {!book && (resource.isLoading || resource.error) ? (
        <p className="mt-5 text-sm text-stone-500 dark:text-stone-400">{resource.isLoading ? '正在查找最近阅读的图书…' : '书架读取成功后，会在这里显示最近阅读的图书。'}</p>
      ) : book && availability ? (
        <div className="profile-continue mt-6 flex flex-col gap-5 sm:flex-row">
          <Link className="shrink-0 self-center transition-transform duration-200 ease-out hover:-translate-y-1.5 sm:self-start" state={navigationState} to={getBookDetailPath(book.id)}>
            <BookCover book={book} size="lg" />
          </Link>
          <div className="min-w-0 flex-1">
            <p className={LABEL}>{hasBookReadingHistory(book) ? '最近停在' : '尚未开始'}</p>
            <h3 className="mt-2 line-clamp-2 break-words font-display text-2xl font-semibold leading-snug lg:text-lg text-stone-950 dark:text-night-ink" title={book.title}>{book.title}</h3>
            <p className="mt-2 truncate text-sm text-stone-500 dark:text-stone-400" title={book.currentChapter ?? (hasBookReadingHistory(book) ? getBookProgressLabel(book.progressPercent, book.lastReadAt).label : '未开始')}>{book.currentChapter ?? (hasBookReadingHistory(book) ? getBookProgressLabel(book.progressPercent, book.lastReadAt).label : '未开始')}</p>
            <ProgressBar className="mt-5 max-w-lg" value={book.progressPercent} />
            <div className="mt-5 flex flex-wrap gap-3">
              <LinkButton className="min-h-10 px-4" icon={availability.canReadInBrowser ? <Play className="h-4 w-4 fill-current" /> : <ArrowRight className="h-4 w-4" />} title={availability.reason} state={navigationState} to={availability.entryPath}>
                {availability.canReadInBrowser ? (hasBookReadingHistory(book) ? '继续阅读' : '开始阅读') : '查看详情'}
              </LinkButton>
              {availability.canReadInBrowser && <LinkButton className="min-h-10 px-4" state={navigationState} to={getBookDetailPath(book.id)} variant="secondary">
                查看详情
              </LinkButton>}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <p className="text-sm text-stone-500 dark:text-stone-400">书架还没有书</p>
          <LinkButton className="min-h-9 px-4 text-xs" to={ROUTES.upload} variant="secondary">
            上传第一本
          </LinkButton>
        </div>
      )}
    </Panel>
  );
}

function UploadOverviewPanel({ tasks, resource }: { tasks: UploadTask[]; resource: ProfileResource<UploadTask[]> }) {
  return (
    <Panel>
      <SectionHeader
        action={
          <Link className="inline-flex min-h-10 items-center gap-1 text-sm text-stone-400 hover:text-accent dark:text-stone-500 dark:hover:text-accent-soft" to={ROUTES.upload}>
            上传页 <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
        title="上传记录"
      />
      <ProfileResourceFeedback label="上传记录" error={resource.error} isLoading={resource.isLoading} hasData={Boolean(resource.data)} onRetry={resource.retry} />
      <div className={cn('mt-2 divide-y', HAIRLINE, 'divide-hairline dark:divide-white/10')}>
        {tasks.slice(0, 4).map((task) => {
          const meta = getUploadStatusMeta(task.status);
          return (
            <div className="py-4" key={task.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-900 dark:text-night-ink">{task.fileName}</p>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    {task.fileType} · {formatFileSize(task.fileSize)}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-sakura px-2.5 py-1 text-xs font-medium text-accent-strong dark:bg-plum/50 dark:text-peach">{meta.label}</span>
              </div>
              <ProgressBar className="mt-3" label={`${task.fileName}导入进度`} value={task.progress} />
            </div>
          );
        })}
        {!resource.isLoading && !resource.error && tasks.length === 0 && <p className="py-4 text-sm text-stone-500 dark:text-stone-400">暂无上传记录</p>}
      </div>
    </Panel>
  );
}

function AccountPanel({ onLogout, session }: { onLogout: () => void | Promise<void>; session: ReturnType<typeof useSession>['session'] }) {
  const { updateNickname, changePassword } = useSession();
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [newNickname, setNewNickname] = useState('');
  const [isSavingNickname, setIsSavingNickname] = useState(false);
  const [nicknameError, setNicknameError] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ confirm: '', current: '', next: '' });
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const nicknameControllerRef = useRef<AbortController | null>(null);
  const passwordControllerRef = useRef<AbortController | null>(null);
  const nicknameTriggerRef = useRef<HTMLButtonElement>(null);
  const passwordTriggerRef = useRef<HTMLButtonElement>(null);
  const nicknameInputRef = useRef<HTMLInputElement>(null);
  const currentPasswordInputRef = useRef<HTMLInputElement>(null);
  const wasEditingNickname = useRef(false);
  const wasChangingPassword = useRef(false);
  useEffect(() => {
    if (isEditingNickname) revealProfileControl(nicknameInputRef.current);
    else if (wasEditingNickname.current) revealProfileControl(nicknameTriggerRef.current, true);
    wasEditingNickname.current = isEditingNickname;
  }, [isEditingNickname]);
  useEffect(() => {
    if (isChangingPassword) revealProfileControl(currentPasswordInputRef.current);
    else if (wasChangingPassword.current) revealProfileControl(passwordTriggerRef.current, true);
    wasChangingPassword.current = isChangingPassword;
  }, [isChangingPassword]);
  const closeNicknameEditor = () => {
    setIsEditingNickname(false);
    setNicknameError('');
  };
  const closePasswordEditor = () => {
    setIsChangingPassword(false);
  };

  useEffect(() => () => {
    nicknameControllerRef.current?.abort();
    passwordControllerRef.current?.abort();
    nicknameControllerRef.current = null;
    passwordControllerRef.current = null;
  }, []);

  const resetPasswordForm = () => {
    setPasswordForm({ confirm: '', current: '', next: '' });
    setPasswordError('');
  };

  const handleChangePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (passwordControllerRef.current) return;
    setPasswordError('');
    setPasswordSuccess('');

    if (passwordForm.next.length < 8) {
      setPasswordError('新密码至少需要 8 位');
      return;
    }
    if (new TextEncoder().encode(passwordForm.next).length > 72) {
      setPasswordError('新密码过长，请减少字符后重试。');
      return;
    }
    if (passwordForm.next !== passwordForm.confirm) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    if (passwordForm.next === passwordForm.current) {
      setPasswordError('新密码不能与当前密码相同');
      return;
    }

    setIsSavingPassword(true);
    const passwordController = new AbortController();
    passwordControllerRef.current = passwordController;
    try {
      await changePassword(passwordForm.current, passwordForm.next, passwordController.signal);
      if (passwordController.signal.aborted) return;
      closePasswordEditor();
      resetPasswordForm();
      setPasswordSuccess('密码已更新');
    } catch (error) {
      if (!passwordController.signal.aborted && !isAbortError(error)) setPasswordError(error instanceof Error ? error.message : '密码更新失败');
    } finally {
      if (passwordControllerRef.current === passwordController) passwordControllerRef.current = null;
      if (!passwordController.signal.aborted) setIsSavingPassword(false);
    }
  };

  const handleSaveNickname = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nicknameControllerRef.current) return;
    if (!newNickname.trim()) {
      setNicknameError('昵称不能为空');
      return;
    }
    setIsSavingNickname(true);
    setNicknameError('');
    const nicknameController = new AbortController();
    nicknameControllerRef.current = nicknameController;
    try {
      await updateNickname(newNickname.trim(), nicknameController.signal);
      if (nicknameController.signal.aborted) return;
      closeNicknameEditor();
    } catch (err) {
      if (!nicknameController.signal.aborted && !isAbortError(err)) setNicknameError(err instanceof Error ? err.message : '保存昵称失败');
    } finally {
      if (nicknameControllerRef.current === nicknameController) nicknameControllerRef.current = null;
      if (!nicknameController.signal.aborted) setIsSavingNickname(false);
    }
  };

  return (
    <Panel>
      <SectionHeader title="账号" />
      <dl className="mt-2 text-sm">
        <div className={cn('border-b py-3.5', HAIRLINE)}>
          <dt className={LABEL}>昵称</dt>
          {isEditingNickname ? (
            <form aria-label="修改昵称" aria-busy={isSavingNickname} onSubmit={handleSaveNickname} className="mt-2 flex items-center gap-2" onKeyDown={(event) => {
              if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Escape' && !isSavingNickname) { event.preventDefault(); closeNicknameEditor(); }
            }}>
              <input
                aria-label="昵称"
                ref={nicknameInputRef}
                aria-describedby={nicknameError ? 'profile-nickname-error' : undefined}
                aria-invalid={Boolean(nicknameError)}
                autoComplete="nickname"
                maxLength={80}
                type="text"
                value={newNickname}
                onChange={(e) => setNewNickname(e.target.value)}
                className="min-h-11 min-w-0 w-full flex-1 rounded-lg border border-stone-200 bg-shell px-2.5 py-1 text-base text-stone-900 sm:text-sm outline-none focus:border-accent dark:border-white/10 dark:bg-stone-900 dark:text-night-ink"
                disabled={isSavingNickname}
                autoFocus
              />
              <button
                type="submit"
                disabled={isSavingNickname}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-accent-strong text-white transition hover:bg-accent-deep disabled:opacity-50"
                aria-label="保存昵称"
                title="保存"
              >
                {isSavingNickname ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  closeNicknameEditor();
                }}
                disabled={isSavingNickname}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-600 transition hover:bg-stone-200 dark:bg-stone-800 dark:text-night-soft dark:hover:bg-stone-700"
                aria-label="取消修改昵称"
                title="取消"
              >
                <X className="h-4 w-4" />
              </button>
            </form>
          ) : (
            <dd className="mt-1.5 flex items-center justify-between gap-2">
              <span className="truncate font-medium text-stone-700 dark:text-night-copy" title={session?.nickname ?? '暂无'}>
                {session?.nickname ?? '暂无'}
              </span>
              <button
                ref={nicknameTriggerRef}
                aria-label="修改昵称"
                type="button"
                onClick={() => {
                  setNewNickname(session?.nickname ?? '');
                  setIsEditingNickname(true);
                  setNicknameError('');
                }}
                className="grid h-10 w-10 place-items-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-stone-800 dark:hover:text-night-copy"
                title="修改昵称"
              >
                <Edit2 className="h-3.5 w-3.5" />
              </button>
            </dd>
          )}
          {nicknameError && (
            <p id="profile-nickname-error" role="alert" className="mt-1 whitespace-pre-wrap text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{nicknameError}</p>
          )}
        </div>
        <ProfileField label="邮箱" value={session?.email ?? '暂无'} />
        <ProfileField label="账号标识" value={session ? formatAccountCode(session.accountNumber, session.id) : '暂无'} />
        <ProfileField label="角色" value={session?.role === 'admin' ? '管理员' : '普通用户'} />
        <ProfileField label="状态" value={getStatusLabel(session?.status)} />
      </dl>

      <div className="mt-5">
        {isChangingPassword ? (
          <form aria-label="修改密码" aria-busy={isSavingPassword} className="space-y-3" onSubmit={handleChangePassword} onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape' && !isSavingPassword) { event.preventDefault(); closePasswordEditor(); resetPasswordForm(); }
          }}>
            <p className={LABEL}>修改密码</p>
            <label className="grid gap-1.5"><span className={LABEL}>当前密码</span>
            <input
              aria-label="当前密码"
              ref={currentPasswordInputRef}
              autoFocus
              required
              maxLength={256}
              autoComplete="current-password"
              className="min-h-11 w-full rounded-lg border border-stone-200 bg-shell px-2.5 py-1.5 text-base sm:text-sm text-stone-900 outline-none focus:border-accent dark:border-white/10 dark:bg-stone-900 dark:text-night-ink"
              disabled={isSavingPassword}
              onChange={(event) => setPasswordForm((current) => ({ ...current, current: event.target.value }))}
              placeholder="当前密码"
              type="password"
              value={passwordForm.current}
            />
            </label>
            <label className="grid gap-1.5"><span className={LABEL}>新密码</span>
            <input
              aria-label="新密码"
              required
              maxLength={256}
              autoComplete="new-password"
              className="min-h-11 w-full rounded-lg border border-stone-200 bg-shell px-2.5 py-1.5 text-base sm:text-sm text-stone-900 outline-none focus:border-accent dark:border-white/10 dark:bg-stone-900 dark:text-night-ink"
              disabled={isSavingPassword}
              onChange={(event) => setPasswordForm((current) => ({ ...current, next: event.target.value }))}
              placeholder="新密码（至少 8 位）"
              type="password"
              value={passwordForm.next}
            />
            </label>
            <label className="grid gap-1.5"><span className={LABEL}>确认新密码</span>
            <input
              aria-label="确认新密码"
              required
              maxLength={256}
              autoComplete="new-password"
              className="min-h-11 w-full rounded-lg border border-stone-200 bg-shell px-2.5 py-1.5 text-base sm:text-sm text-stone-900 outline-none focus:border-accent dark:border-white/10 dark:bg-stone-900 dark:text-night-ink"
              disabled={isSavingPassword}
              onChange={(event) => setPasswordForm((current) => ({ ...current, confirm: event.target.value }))}
              placeholder="再次输入新密码"
              type="password"
              value={passwordForm.confirm}
            />
            </label>
            {passwordError && <p role="alert" className="whitespace-pre-wrap text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{passwordError}</p>}
            <div className="flex gap-2">
              <Button className="flex-1" disabled={isSavingPassword} icon={isSavingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} type="submit">
                {isSavingPassword ? '保存中...' : '保存新密码'}
              </Button>
              <Button
                disabled={isSavingPassword}
                onClick={() => {
                  closePasswordEditor();
                  resetPasswordForm();
                }}
                type="button"
                variant="secondary"
              >
                取消
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className={LABEL}>密码</p>
              {passwordSuccess && <p role="status" className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">{passwordSuccess}</p>}
            </div>
            <Button
              ref={passwordTriggerRef}
              icon={<ShieldCheck className="h-4 w-4" />}
              onClick={() => {
                setPasswordSuccess('');
                setIsChangingPassword(true);
              }}
              variant="secondary"
            >
              修改密码
            </Button>
          </div>
        )}
      </div>

      <Button className="mt-6 w-full" icon={<LogOut className="h-4 w-4" />} onClick={onLogout} variant="secondary">
        退出登录
      </Button>
    </Panel>
  );
}

function InvitationOverviewPanel({ copyState, errorMessage, invitationQuota, isCreating, isUnconfirmed, onCopy, onCreate, resource }: { resource: ProfileResource<InvitationQuota>; copyState: 'idle' | 'copying' | 'copied'; errorMessage: string; invitationQuota: InvitationQuota | null; isCreating: boolean; isUnconfirmed: boolean; onCopy: () => void | Promise<void>; onCreate: () => void | Promise<void> }) {
  const invitation = invitationQuota?.invitation;
  const canCopy = invitation?.status === 'available' && !isCreating && !isUnconfirmed;
  const canCreate = Boolean(invitationQuota?.can_create) && !resource.isLoading && !resource.error && !isUnconfirmed;
  const createLabel = invitation ? '重新生成' : '生成邀请码';
  let codeStatus = invitation ? getInvitationStatusLabel(invitation.status) : '';
  if (isCreating) codeStatus = '正在更新邀请码，请等待生成结果。';
  else if (isUnconfirmed) codeStatus = resource.error ? '生成结果尚未确认，请重试读取邀请额度。' : '正在确认生成结果，请稍候。';

  return (
    <Panel>
      <SectionHeader title="邀请" />
      <ProfileResourceFeedback label="邀请额度" error={resource.error} isLoading={resource.isLoading} hasData={Boolean(resource.data)} onRetry={resource.retry} />
      {invitation ? (
        <div className={cn('mt-2 border-b py-4', HAIRLINE)}>
          <p className={LABEL}>{isUnconfirmed ? '上次邀请码（待确认）' : '当前邀请码'}</p>
          <p className="mt-2 select-all break-all font-mono text-2xl font-semibold tracking-[0.18em] text-stone-950 dark:text-night-ink">{invitation.code}</p>
          <p className="mt-2 text-xs text-stone-500 dark:text-stone-400" role={isCreating || isUnconfirmed ? 'status' : undefined}>{codeStatus}</p>
          <Button className="mt-4 w-full" disabled={!canCopy || copyState === 'copying'} icon={copyState === 'copied' ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />} onClick={onCopy} variant="secondary">
            {copyState === 'copying' ? '正在复制…' : copyState === 'copied' ? '已复制' : '复制邀请码'}
          </Button>
        </div>
      ) : !resource.isLoading && !resource.error ? (
        <p className="mt-2 py-4 text-sm text-stone-500 dark:text-stone-400">暂无可用邀请码</p>
      ) : null}
      <Button className="mt-4 w-full" disabled={!canCreate || isCreating} icon={isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} onClick={onCreate} variant="secondary">
        {isCreating ? '正在生成…' : createLabel}
      </Button>
      {errorMessage && <p role="alert" className="mt-3 whitespace-pre-wrap rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600 [overflow-wrap:anywhere] dark:bg-red-950/30 dark:text-red-300">{errorMessage}</p>}
    </Panel>
  );
}

function AdminQuickPanel() {
  return (
    <Panel>
      <SectionHeader title="后台" />
      <LinkButton className="mt-5 w-full" icon={<UserRound className="h-4 w-4" />} to={ROUTES.adminUsers} variant="secondary">
        查看用户和状态
      </LinkButton>
    </Panel>
  );
}

function ProfileField({ label, value }: { label: string; value: string }) {
  return (
    <div className={cn('border-b py-3.5', HAIRLINE)}>
      <dt className={LABEL}>{label}</dt>
      <dd className="mt-1.5 truncate text-stone-700 dark:text-night-copy" title={value}>{value}</dd>
    </div>
  );
}

function getInvitationStatusLabel(status: 'available' | 'used' | 'revoked') {
  if (status === 'available') {
    return '未使用，可发给朋友注册';
  }
  if (status === 'used') {
    return '已被使用，不能再注册';
  }
  return '已作废，不能再注册';
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
