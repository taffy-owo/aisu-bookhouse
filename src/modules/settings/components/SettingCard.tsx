import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { HAIRLINE } from '../../../shared/ui';
import { cn } from '../../../shared/utils/cn';

interface SettingCardProps {
  action?: string;
  description: string;
  icon: LucideIcon;
  title: string;
  to?: string;
  onClick?: () => void;
  disabled?: boolean;
  isBusy?: boolean;
}

export function SettingCard({ action, description, icon: Icon, title, to, onClick, disabled = false, isBusy = false }: SettingCardProps) {
  const content = (
    <>
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-stone-100 text-accent dark:bg-white/10 dark:text-accent-soft">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 text-stone-900 dark:text-night-ink">
        <div className="font-medium">{title}</div>
        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{description}</div>
        {action && <div role={onClick ? 'status' : undefined} className="mt-2 text-xs font-medium text-accent dark:text-accent-soft sm:mt-3">{action}</div>}
      </div>
    </>
  );

  const className = cn('settings-row flex items-center gap-4 py-4 border-b transition text-left w-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01]', HAIRLINE);

  if (to) {
    return (
      <Link className={className} to={to}>
        {content}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button aria-busy={isBusy} disabled={disabled} className={cn(className, 'disabled:cursor-wait disabled:opacity-60')} onClick={onClick} type="button">
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}
