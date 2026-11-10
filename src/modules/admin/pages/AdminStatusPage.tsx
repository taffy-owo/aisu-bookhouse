import { AlertTriangle, CalendarDays, Check, CheckCircle2, ChevronLeft, Database, Download, FileText, HardDrive, Loader2, LockKeyhole, Power, PowerOff, RefreshCw, ShieldCheck, Table2, UserRound, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../../app/SessionContext';
import { ROUTES } from '../../../config/routes';
import { formatAccountCode } from '../../auth/services/accountCode';
import { getApiBaseUrl } from '../../../shared/api';
import { Button } from '../../../shared/components/Button';
import { Panel } from '../../../shared/components/Panel';
import { UserAvatar } from '../../../shared/components/UserAvatar';
import { formatDate } from '../../../shared/utils/formatDate';
import { formatFileSize } from '../../../shared/utils/formatFileSize';
import { BackupMaintenancePanel } from '../components/BackupMaintenancePanel';
import { useAdminConsole } from '../hooks/useAdminConsole';
import type { AdminSystemIssue, AdminSystemReport, AdminUser } from '../services/adminService';

export function AdminStatusPage() {
  const { session } = useSession();
  const [activeSection, setActiveSection] = useState<'users' | 'review' | 'maintenance'>('users');
  const {
    errorMessage, handleModerateBook, handleStatusChange, isLoading, isPendingBooksLoading, isSystemLoading,
    loadPendingBooks, loadSystemReport, loadUsers, moderatingBookIds, pendingBooks, pendingBooksError,
    systemReport, systemReportError, updatingUserIds, users,
  } = useAdminConsole(session?.id);

  const stats = useMemo(() => {
    const activeUsers = users.filter((user) => user.status === 'active').length;
    const adminUsers = users.filter((user) => user.role === 'admin').length;
    return [
      { label: '总账号', value: users.length },
      { label: '正常账号', value: activeUsers },
      { label: '管理员', value: adminUsers },
      { label: '停用账号', value: users.length - activeUsers },
    ];
  }, [users]);

  return (
    <div className="admin-page space-y-4">
      <Panel>
        <Link className="inline-flex min-h-9 items-center gap-2 text-sm text-stone-500 hover:text-accent dark:text-night-soft" to={ROUTES.settings}>
          <ChevronLeft className="h-4 w-4" />返回设置
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="app-page-title font-display text-3xl font-semibold text-stone-950 dark:text-night-ink">管理中心</h1>
            <p className="mt-2 text-sm text-stone-500 dark:text-night-soft">账号、公共书库审核与系统维护。</p>
          </div>
          <Button disabled={isLoading} icon={isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} onClick={loadUsers} variant="secondary">刷新账号</Button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((stat) => (
            <div className="flex items-baseline justify-between gap-2 rounded-xl border border-stone-200 px-3 py-2 dark:border-white/10 dark:bg-white/[0.025]" key={stat.label}>
              <span className="text-xs text-stone-500 dark:text-stone-400">{stat.label}</span>
              <span className="text-xl font-semibold tabular-nums text-stone-950 dark:text-night-ink">{stat.value}</span>
            </div>
          ))}
        </div>
      </Panel>
      <nav aria-label="管理分类" className="flex flex-wrap gap-2 border-b border-ink/10 pb-3 dark:border-white/10">
        {([
          ['users', '账号列表'],
          ['review', `公共书库审核${pendingBooks.length ? ` · ${pendingBooks.length}` : ''}`],
          ['maintenance', `系统维护${systemReport?.issues.some((issue) => issue.severity !== 'info') || systemReportError ? ' · 需检查' : ''}`],
        ] as const).map(([key, label]) => (
          <button aria-pressed={activeSection === key} className={`min-h-11 rounded-xl px-4 text-sm transition lg:min-h-9 ${activeSection === key ? 'bg-accent-strong text-white' : 'bg-stone-100 text-stone-600 dark:bg-white/5 dark:text-night-copy'}`} key={key} onClick={() => setActiveSection(key)} type="button">{label}</button>
        ))}
      </nav>

      {errorMessage && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">{errorMessage}</div>}

      <div className="space-y-4" hidden={activeSection !== 'maintenance'}>
        <SystemMaintenancePanel errorMessage={systemReportError} isLoading={isSystemLoading} report={systemReport} onRefresh={loadSystemReport} />
        <BackupMaintenancePanel />
      </div>

      {activeSection === 'review' && <Panel>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink">公共书库审核</h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">用户提交后，需要管理员通过才会进入公共书库。</p>
          </div>
          <Button disabled={isPendingBooksLoading || moderatingBookIds.size > 0} icon={isPendingBooksLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} onClick={loadPendingBooks} variant="secondary">
            刷新
          </Button>
        </div>

        {pendingBooksError && <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">审核清单加载失败：{pendingBooksError}，请点击「刷新」重试。</div>}

        <div className="mt-5 divide-y divide-stone-200 overflow-hidden rounded-[24px] border border-stone-200 dark:divide-white/10 dark:border-white/10">
          {isPendingBooksLoading ? (
            <div className="grid min-h-32 place-items-center text-sm text-stone-500 dark:text-stone-400"><Loader2 className="h-4 w-4 animate-spin" /></div>
          ) : pendingBooks.length === 0 ? (
            <p className="bg-white/[0.72] p-5 text-sm text-stone-500 dark:bg-white/[0.03] dark:text-stone-400">没有等待审核的图书。</p>
          ) : (
            pendingBooks.map((book) => {
              const isModerating = moderatingBookIds.has(book.id);
              const DownloadIcon = book.publicDownloadAllowed === false ? LockKeyhole : Download;
              return (
                <div className="grid gap-4 bg-white/[0.72] p-4 dark:bg-white/[0.03] lg:grid-cols-[minmax(0,1fr)_220px] lg:items-center" key={book.id}>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-stone-950 dark:text-night-ink" title={book.title}>{book.title}</p>
                    <p className="mt-1 truncate text-sm text-stone-500 dark:text-stone-400" title={`${book.author} · ${book.fileExt ?? book.readerType}`}>{book.author} · {book.fileExt ?? book.readerType}</p>
                    <p className="mt-2 line-clamp-2 text-sm leading-6 text-stone-500 dark:text-stone-400">{book.description || '没有简介'}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {book.ownerNickname && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500 dark:bg-white/[0.06] dark:text-night-soft">
                          <UserRound className="h-3.5 w-3.5" />
                          {book.ownerNickname}
                        </span>
                      )}
                      {book.publicRequestedAt && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500 dark:bg-white/[0.06] dark:text-night-soft">
                          <CalendarDays className="h-3.5 w-3.5" />
                          {formatDate(book.publicRequestedAt)}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500 dark:bg-white/[0.06] dark:text-night-soft">
                        <DownloadIcon className="h-3.5 w-3.5" />
                        {book.publicDownloadAllowed === false ? '仅在线阅读' : '允许下载'}
                      </span>
                    </div>
                    {(book.publicShareNote || book.publicSourceNote) && (
                      <div className="mt-3 space-y-1 rounded-2xl bg-stone-50 px-3 py-2 text-sm leading-6 text-stone-600 dark:bg-white/[0.04] dark:text-night-soft">
                        {book.publicShareNote && <p><FileText className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />{book.publicShareNote}</p>}
                        {book.publicSourceNote && <p className="text-xs text-stone-500 dark:text-stone-400">来源：{book.publicSourceNote}</p>}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <Button disabled={isModerating} icon={<Check className="h-4 w-4" />} onClick={() => void handleModerateBook(book, 'approve')} variant="secondary">
                      通过
                    </Button>
                    <Button disabled={isModerating} icon={<X className="h-4 w-4" />} onClick={() => void handleModerateBook(book, 'reject')} variant="danger">
                      拒绝
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Panel>}

      {activeSection === 'users' && <Panel>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink">账号列表</h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">查看账号身份与状态；当前登录账号已保护。</p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-2xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-400">
            <Database className="h-3.5 w-3.5" />
            {getApiBaseUrl()}
          </div>
        </div>

        <div className="mt-5 overflow-hidden rounded-[24px] border border-stone-200 dark:border-white/10">
          {isLoading ? (
            <div className="grid min-h-56 place-items-center text-sm text-stone-500 dark:text-stone-400">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在加载用户
              </span>
            </div>
          ) : (
            <div className="divide-y divide-stone-200 dark:divide-white/10">
              {users.map((user) => {
                const isSelf = user.id === session?.id;
                const isUpdating = updatingUserIds.has(user.id);
                const nextAction = user.status === 'active' ? '停用' : '启用';

                return (
                  <div className="grid gap-4 bg-white/[0.72] p-4 dark:bg-white/[0.03] lg:grid-cols-[minmax(0,1fr)_100px_110px_100px] lg:items-center" key={user.id}>
                    <div className="flex min-w-0 items-center gap-3">
                      <UserAvatar avatar={user.avatar} name={user.nickname} role={user.role} size="lg" userId={user.id} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-medium text-stone-950 dark:text-night-ink" title={user.nickname}>{user.nickname}</p>
                          <span className="font-mono text-xs text-stone-400">{formatAccountCode(user.account_number, user.id)}</span>
                          {isSelf && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">当前账号</span>}
                        </div>
                        <p className="mt-1 truncate text-sm text-stone-500 dark:text-stone-400" title={user.email}>{user.email}</p>
                      </div>
                    </div>

                    <StatusPill status={user.status} />

                    <div className="inline-flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                      <ShieldCheck className="h-4 w-4 text-accent" />
                      {user.role === 'admin' ? '管理员' : '普通用户'}
                    </div>

                    <Button
                      className="min-h-10 px-3"
                      disabled={isSelf || isUpdating}
                      icon={isUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : user.status === 'active' ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                      onClick={() => handleStatusChange(user)}
                      variant={user.status === 'active' ? 'danger' : 'secondary'}
                    >
                      {isSelf ? '已保护' : nextAction}
                    </Button>
                  </div>
                );
              })}
              {users.length === 0 && <p className="bg-white/[0.72] p-5 text-sm text-stone-500 dark:bg-white/[0.03] dark:text-stone-400">还没有用户。</p>}
            </div>
          )}
        </div>
      </Panel>}
    </div>
  );
}

function SystemMaintenancePanel({ errorMessage, isLoading, onRefresh, report }: { errorMessage?: string; isLoading?: boolean; onRefresh: () => void; report: AdminSystemReport | null }) {
  const dangerCount = report?.issues.filter((issue) => issue.severity === 'danger').length ?? 0;
  const warningCount = report?.issues.filter((issue) => issue.severity === 'warning').length ?? 0;
  const isHealthy = Boolean(report) && dangerCount === 0 && warningCount === 0;

  return (
    <Panel>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink">系统维护</h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">检查数据库、存储目录和文件索引是否一致。</p>
        </div>
        <Button disabled={isLoading} icon={isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} onClick={onRefresh} variant="secondary">
          重新检查
        </Button>
      </div>

      {!report ? (
        errorMessage ? (
          <div className="mt-5 flex flex-wrap items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">系统状态加载失败</p>
              <p className="mt-1 text-xs leading-5 opacity-80">{errorMessage}，可点击「重新检查」重试。</p>
            </div>
          </div>
        ) : (
          <div className="mt-5 grid min-h-32 place-items-center rounded-2xl border border-dashed border-stone-200 text-sm text-stone-500 dark:border-white/10 dark:text-stone-400">
            正在读取系统状态
          </div>
        )
      ) : (
        <>
          <div className="mt-5 grid gap-3 md:grid-cols-4">
            <SystemMetric icon={<Database className="h-4 w-4" />} label="数据库" value={formatFileSize(report.database_size_bytes + report.database_auxiliary_size_bytes)} />
            <SystemMetric icon={<HardDrive className="h-4 w-4" />} label="文件存储" value={formatFileSize(report.storage_size_bytes)} />
            <SystemMetric icon={<Table2 className="h-4 w-4" />} label="数据表" value={`${report.table_stats.length} 张`} />
            <SystemMetric icon={isHealthy ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} label="健康检查" value={isHealthy ? '正常' : `${dangerCount + warningCount} 项注意`} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
            <div className="rounded-2xl border border-stone-200 p-4 dark:border-white/10">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-stone-950 dark:text-night-ink">数据库状态</h3>
                <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500 dark:bg-white/[0.06] dark:text-night-soft">{report.database_engine}</span>
              </div>
              <dl className="mt-3 grid gap-2 text-sm text-stone-500 dark:text-stone-400">
                <div className="flex justify-between gap-3"><dt>SQLite 检查</dt><dd className="text-stone-900 dark:text-night-ink">{report.sqlite_quick_check ?? '不适用'}</dd></div>
                <div className="flex justify-between gap-3"><dt>外键保护</dt><dd className="text-stone-900 dark:text-night-ink">{report.sqlite_foreign_keys ? '开启' : '未开启'}</dd></div>
                <div className="flex justify-between gap-3"><dt>日志模式</dt><dd className="text-stone-900 dark:text-night-ink">{report.sqlite_journal_mode ?? '不适用'}</dd></div>
              </dl>
            </div>

            <div className="rounded-2xl border border-stone-200 p-4 dark:border-white/10">
              <h3 className="text-sm font-semibold text-stone-950 dark:text-night-ink">数据量</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {report.table_stats.map((table) => (
                  <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500 dark:bg-white/[0.06] dark:text-night-soft" key={table.name}>
                    {getTableLabel(table.name)}：{table.rows}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {report.issues.map((issue) => (
              <SystemIssueRow issue={issue} key={issue.code} />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function SystemMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-cream/60 p-4 dark:border-white/10 dark:bg-white/[0.04]">
      <div className="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-white text-accent shadow-sm dark:bg-white/10">{icon}</div>
      <p className="mt-3 text-xl font-semibold text-stone-950 dark:text-night-ink">{value}</p>
      <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{label}</p>
    </div>
  );
}

function SystemIssueRow({ issue }: { issue: AdminSystemIssue }) {
  const Icon = issue.severity === 'info' ? CheckCircle2 : AlertTriangle;
  const className = issue.severity === 'danger'
    ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300'
    : issue.severity === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-300';

  return (
    <div className={`flex flex-wrap items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${className}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{issue.title}{issue.count > 0 ? ` · ${issue.count}` : ''}</p>
        <p className="mt-1 text-xs leading-5 opacity-80">{issue.detail}</p>
      </div>
    </div>
  );
}

function getTableLabel(tableName: string): string {
  const labels: Record<string, string> = {
    ai_translation_cache: '翻译缓存',
    book_assets: '书籍资源',
    books: '书籍',
    invitations: '邀请码',
    public_comments: '评论',
    reader_marks: '标记',
    reading_progress: '进度',
    upload_tasks: '上传任务',
    user_ai_settings: 'AI 设置',
    users: '用户',
  };
  return labels[tableName] ?? tableName;
}

function StatusPill({ status }: { status: AdminUser['status'] }) {
  const isActive = status === 'active';
  return (
    <span className={isActive ? 'inline-flex w-fit items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 dark:bg-emerald-950/25 dark:text-emerald-300' : 'inline-flex w-fit items-center gap-2 rounded-full bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-500 dark:bg-white/10 dark:text-night-soft'}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {isActive ? '正常' : '已停用'}
    </span>
  );
}
