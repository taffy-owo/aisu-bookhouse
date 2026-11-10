import { apiDownload, apiRequest } from '../../../shared/api';

export type AdminUser = {
  account_number?: number | null;
  avatar?: string | null;
  created_at: string;
  email: string;
  id: string;
  nickname: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  updated_at: string;
};

export type AdminSystemTableStat = {
  name: string;
  rows: number;
};

export type AdminSystemIssue = {
  code: string;
  severity: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
  count: number;
};

export type AdminSystemReport = {
  checked_at: string;
  database_auxiliary_size_bytes: number;
  database_engine: string;
  database_path?: string | null;
  database_size_bytes: number;
  issues: AdminSystemIssue[];
  sqlite_foreign_keys?: boolean | null;
  sqlite_journal_mode?: string | null;
  sqlite_quick_check?: string | null;
  storage_root: string;
  storage_size_bytes: number;
  table_stats: AdminSystemTableStat[];
};


export type AdminBackupInfo = {
  created_at: string;
  database_engine: string;
  filename: string;
  format_version: number;
  size_bytes: number;
  storage_size_bytes: number;
};

export type AdminBackupListResponse = {
  backups: AdminBackupInfo[];
};

export type AdminRestoreResult = {
  restored_from: AdminBackupInfo;
  safety_backup: AdminBackupInfo;
};
export async function getAdminUsers(signal?: AbortSignal): Promise<AdminUser[]> {
  return apiRequest<AdminUser[]>('/admin/users', { signal });
}

export async function getAdminSystemReport(signal?: AbortSignal): Promise<AdminSystemReport> {
  return apiRequest<AdminSystemReport>('/admin/system', { signal });
}

export async function getAdminBackups(signal?: AbortSignal): Promise<AdminBackupInfo[]> {
  const response = await apiRequest<AdminBackupListResponse>('/admin/backups', { signal });
  return response.backups;
}

export async function createAdminBackup(): Promise<AdminBackupInfo> {
  return apiRequest<AdminBackupInfo>('/admin/backups', { method: 'POST' });
}

export async function downloadAdminBackup(filename: string): Promise<Blob> {
  return apiDownload(`/admin/backups/${encodeURIComponent(filename)}/download`);
}

export async function restoreAdminBackup(file: File, confirmation: string): Promise<AdminRestoreResult> {
  const body = new FormData();
  body.set('backup_file', file);
  body.set('confirmation', confirmation);
  return apiRequest<AdminRestoreResult>('/admin/backups/restore', { body, method: 'POST' });
}

export async function updateAdminUserStatus(userId: string, status: AdminUser['status'], signal?: AbortSignal): Promise<AdminUser> {
  return apiRequest<AdminUser>(`/admin/users/${userId}/status`, {
    body: JSON.stringify({ status }),
    method: 'PATCH',
    ...(signal ? { signal } : {}),
  });
}
