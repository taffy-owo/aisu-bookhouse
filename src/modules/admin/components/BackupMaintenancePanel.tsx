import { Download, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../../../app/SessionContext';
import { Button } from '../../../shared/components/Button';
import { Panel } from '../../../shared/components/Panel';
import { isAbortError } from '../../../shared/utils/abortError';
import { formatDate } from '../../../shared/utils/formatDate';
import { formatFileSize } from '../../../shared/utils/formatFileSize';
import { downloadAdminBackup, getAdminBackups, type AdminBackupInfo } from '../services/adminService';

type BackupAction = 'download' | 'refresh';

const TEXT = {
  download: '\u4e0b\u8f7d',
  downloadFailed: '\u4e0b\u8f7d\u5907\u4efd\u5931\u8d25',
  empty: '\u8fd8\u6ca1\u6709\u5907\u4efd\u3002',
  loadFailed: '\u5907\u4efd\u5217\u8868\u52a0\u8f7d\u5931\u8d25',
  loading: '\u6b63\u5728\u8bfb\u53d6\u5907\u4efd',
  refresh: '\u5237\u65b0',
  restoreTitle: '\u6062\u590d\u5907\u4efd',
  storage: '\u6587\u4ef6',
  subtitle: '\u4e00\u81f4\u6027\u5907\u4efd\u548c\u6062\u590d\u9700\u5728\u7ef4\u62a4\u7a97\u53e3\u505c\u6b62\u5e94\u7528\u53ca\u5904\u7406 worker \u540e\u6267\u884c\u3002',
  title: '\u5907\u4efd\u4e0e\u6062\u590d',
} as const;

export function BackupMaintenancePanel() {
  const { session } = useSession();
  const [backups, setBackups] = useState<AdminBackupInfo[]>([]);
  const [downloadingFilename, setDownloadingFilename] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [runningAction, setRunningAction] = useState<BackupAction | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef<AbortController | null>(null);

  const loadBackups = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsLoading(true);
    setErrorMessage('');
    try {
      const result = await getAdminBackups(controller.signal);
      if (!controller.signal.aborted && mountedRef.current) setBackups(result);
    } catch (error) {
      if (!controller.signal.aborted && mountedRef.current && !isAbortError(error)) {
        setErrorMessage(error instanceof Error ? error.message : TEXT.loadFailed);
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (mountedRef.current) setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setBackups([]);
    setErrorMessage('');
    void loadBackups();
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [loadBackups, session?.id]);

  async function handleRefresh() {
    setRunningAction('refresh');
    try {
      await loadBackups();
    } finally {
      setRunningAction(null);
    }
  }

  async function handleDownloadBackup(backup: AdminBackupInfo) {
    setRunningAction('download');
    setDownloadingFilename(backup.filename);
    setErrorMessage('');
    try {
      const blob = await downloadAdminBackup(backup.filename);
      triggerBrowserDownload(blob, backup.filename);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : TEXT.downloadFailed);
    } finally {
      setDownloadingFilename(null);
      setRunningAction(null);
    }
  }

  const isBusy = runningAction !== null;

  return (
    <Panel>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-2xl font-semibold text-stone-950 dark:text-night-ink">{TEXT.title}</h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{TEXT.subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={isBusy || isLoading} icon={runningAction === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} onClick={handleRefresh} variant="secondary">
            {TEXT.refresh}
          </Button>
        </div>
      </div>

      {errorMessage && (
        <div className="mt-4 space-y-2">
          {errorMessage && <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">{errorMessage}</p>}
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <div className="overflow-hidden rounded-2xl border border-stone-200 dark:border-white/10">
          {isLoading ? (
            <div className="grid min-h-40 place-items-center text-sm text-stone-500 dark:text-stone-400">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {TEXT.loading}
              </span>
            </div>
          ) : backups.length === 0 ? (
            <div className="grid min-h-40 place-items-center bg-white/[0.72] p-5 text-sm text-stone-500 dark:bg-white/[0.03] dark:text-stone-400">{TEXT.empty}</div>
          ) : (
            <div className="divide-y divide-stone-200 dark:divide-white/10">
              {backups.map((backup) => (
                <div className="grid gap-3 bg-white/[0.72] p-4 dark:bg-white/[0.03] md:grid-cols-[minmax(0,1fr)_140px] md:items-center" key={backup.filename}>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-stone-950 dark:text-night-ink" title={backup.filename}>{backup.filename}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-stone-500 dark:text-stone-400">
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 dark:bg-white/[0.06]">{formatDate(backup.created_at)}</span>
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 dark:bg-white/[0.06]">{formatFileSize(backup.size_bytes)}</span>
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 dark:bg-white/[0.06]">{TEXT.storage} {formatFileSize(backup.storage_size_bytes)}</span>
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 dark:bg-white/[0.06]">{backup.database_engine}</span>
                    </div>
                  </div>
                  <Button className="min-h-10 px-3" disabled={isBusy} icon={runningAction === 'download' && downloadingFilename === backup.filename ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} onClick={() => void handleDownloadBackup(backup)} variant="secondary">
                    {TEXT.download}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/40 dark:bg-amber-950/15">
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">{TEXT.restoreTitle}</h3>
          <p className="mt-2 text-xs leading-5 text-amber-800/80 dark:text-amber-100/70">请联系服务器管理员安排维护窗口。停用应用与上传 worker 后，使用 backup_cli restore --file 备份路径 --confirm RESTORE；完成校验后再重新启动服务。</p>
        </div>
      </div>
    </Panel>
  );
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
