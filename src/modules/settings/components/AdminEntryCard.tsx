import { Users } from 'lucide-react';
import { ROUTES } from '../../../config/routes';
import { SettingCard } from './SettingCard';

export function AdminEntryCard() {
  return (
    <SettingCard
      action="管理用户"
      description="查看账号编号、状态和登录信息，可停用或恢复普通账号。"
      icon={Users}
      title="用户管理"
      to={ROUTES.adminUsers}
    />
  );
}
