import { BookOpenText, Cloud, FileText, Moon, RefreshCw, ShieldCheck, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROUTES } from '../../../config/routes';
import { Panel } from '../../../shared/components/Panel';
import { useTheme } from '../../../shared/theme';
import { useSession } from '../../../app/SessionContext';
import { SectionHeader } from '../../library/components/SectionHeader';
import { AdminEntryCard } from '../components/AdminEntryCard';
import { SettingCard } from '../components/SettingCard';
import { HAIRLINE } from '../../../shared/ui';
import { cn } from '../../../shared/utils/cn';
import { getAccountScope } from '../../../shared/api';
import { flushReadingActivityOutbox, getPendingReadingActivitySummary } from '../../reading-progress';
import { READING_ACTIVITY_CHANGED_EVENT } from '../../reading-progress/services/readingActivityCache';
import { flushAllReadingProgressSyncs, getPendingReadingProgressSyncCount, subscribeReadingProgressSync } from '../../reader/services/readingProgressSync';
import { AiChannelSettings } from '../components/AiChannelSettings';
import { AiModelSettings } from '../components/AiModelSettings';

export function SettingsPage() {
  const { session } = useSession();
  const { theme, toggleTheme } = useTheme();
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done' | 'error' | 'pending'>('idle');
  const syncRequestRef = useRef(0);
  const isSyncingRef = useRef(false);

  useEffect(() => {
    const scope = getAccountScope();
    syncRequestRef.current += 1;
    isSyncingRef.current = false;
    setSyncState(hasPendingReadingSync() ? 'pending' : 'idle');
    const updateStatus = () => {
      if (scope !== getAccountScope() || isSyncingRef.current) return;
      const pending = hasPendingReadingSync();
      setSyncState((current) => pending
        ? current === 'done' || current === 'idle' ? 'pending' : current
        : current === 'pending' || current === 'error' ? 'done' : current);
    };
    const unsubscribe = subscribeReadingProgressSync(updateStatus);
    window.addEventListener(READING_ACTIVITY_CHANGED_EVENT, updateStatus);
    return () => {
      syncRequestRef.current += 1;
      isSyncingRef.current = false;
      unsubscribe();
      window.removeEventListener(READING_ACTIVITY_CHANGED_EVENT, updateStatus);
    };
  }, [session?.id]);

  const syncNow = async () => {
    if (isSyncingRef.current) return;
    const request = ++syncRequestRef.current;
    const scope = getAccountScope();
    isSyncingRef.current = true;
    setSyncState('syncing');
    // A failed branch must not reopen the controls while another still saves.
    const results = await Promise.allSettled([flushReadingActivityOutbox(), flushAllReadingProgressSyncs()]);
    if (request !== syncRequestRef.current || scope !== getAccountScope()) return;
    isSyncingRef.current = false;
    setSyncState(results.some((result) => result.status === 'rejected') ? 'error' : hasPendingReadingSync() ? 'pending' : 'done');
  };

  return (
    <div className="settings-page mx-auto w-full max-w-[1200px]">
      <Panel>
        <SectionHeader title="设置" />
        <div className="settings-grid mt-4 grid grid-cols-1 lg:grid-cols-2 lg:gap-x-8">
          <ApiDocsSettingCard />
          <button
            className={cn('settings-row flex items-center gap-4 py-4 border-b transition text-left w-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01]', HAIRLINE)}
            onClick={toggleTheme}
            type="button"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-stone-100 text-accent dark:bg-white/10">
              {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-stone-900 dark:text-night-ink">外观</span>
              <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">当前是{theme === 'dark' ? '深色' : '浅色'}模式，点击切换。</span>
            </span>
          </button>
          <SettingCard
            action="在任意图书的阅读页中调整"
            description="在阅读页的外观设置中调整字体、行距、背景和更多排版。"
            icon={BookOpenText}
            title="阅读偏好"
          />
          <SettingCard
            action={syncState === 'syncing' ? '正在同步…' : syncState === 'done' ? '已同步' : syncState === 'error' ? '同步失败，点击重试' : syncState === 'pending' ? '有待同步记录，点击同步' : '立即同步'}
            description="立即重试尚未上传的阅读时长和最后阅读位置。"
            disabled={syncState === 'syncing'}
            isBusy={syncState === 'syncing'}
            icon={syncState === 'syncing' ? RefreshCw : Cloud}
            onClick={() => void syncNow()}
            title="同步"
          />
          <SettingCard action="管理个人资料与邀请" description="每个账号只看到自己的上传内容、阅读记录和收藏。" icon={ShieldCheck} title="隐私与账号" to={ROUTES.profile} />
          {session?.role === 'admin' && <AdminEntryCard />}
        </div>
      </Panel>
      <div className="mt-4 space-y-3">
        <details className="settings-disclosure rounded-xl border border-ink/10 px-4 dark:border-white/10">
          <summary className="cursor-pointer py-3 text-sm font-medium text-stone-900 dark:text-night-ink">第三方 AI 设置<span className="ml-3 font-normal text-stone-500 dark:text-stone-400">日文翻译、听书与翻译预设</span></summary>
          <AiModelSettings />
        </details>
        <details className="settings-disclosure rounded-xl border border-ink/10 px-4 dark:border-white/10">
          <summary className="cursor-pointer py-3 text-sm font-medium text-stone-900 dark:text-night-ink">翻译渠道<span className="ml-3 font-normal text-stone-500 dark:text-stone-400">整本精翻使用的渠道和模型</span></summary>
          <AiChannelSettings />
        </details>
      </div>
    </div>
  );
}

function hasPendingReadingSync(): boolean {
  return getPendingReadingProgressSyncCount() > 0 || getPendingReadingActivitySummary().eventCount > 0;
}

function ApiDocsSettingCard() {
  return (
    <div className={cn('settings-row flex items-start gap-4 border-b py-4', HAIRLINE)}>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-stone-100 text-accent dark:bg-white/10">
        <FileText className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <Link className="block font-medium text-stone-900 transition hover:text-accent dark:text-night-ink dark:hover:text-accent-soft" to={ROUTES.apiDocs}>
          API 文档
        </Link>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">原文抓取、译文提交、项目进度和入库核验的 API 文档。</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium text-accent dark:text-accent-soft">
          <Link to={ROUTES.apiDocs}>查看接口</Link>
          <span aria-hidden="true" className="text-stone-300 dark:text-stone-600">·</span>
          <a href="/api/v1/openapi.json" rel="noreferrer" target="_blank">接口定义</a>
          <span aria-hidden="true" className="text-stone-300 dark:text-stone-600">·</span>
          <a href="/api/v1/ready" rel="noreferrer" target="_blank">服务状态</a>
        </div>
      </div>
    </div>
  );
}

