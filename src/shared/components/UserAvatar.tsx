import { ShieldCheck } from 'lucide-react';
import { cn } from '../utils/cn';
import { buildApiUrl } from '../api/apiConfig';
import { useAuthenticatedImageResource } from '../hooks/useAuthenticatedImageUrl';

interface UserAvatarProps {
  className?: string;
  name: string;
  role?: 'admin' | 'user';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  userId?: string;
  avatar?: string | null;
}

const sizeClass = {
  lg: 'h-14 w-14 text-lg',
  md: 'h-11 w-11 text-sm',
  sm: 'h-9 w-9 text-xs',
  xl: 'h-20 w-20 text-2xl',
};

export function UserAvatar({ className, name, role = 'user', size = 'md', userId, avatar }: UserAvatarProps) {
  const initial = Array.from(name.trim())[0] || '爱';

  // The avatar endpoint requires auth, so load it through the shared
  // authenticated-blob cache (same path as book covers) instead of a bare
  // <img src>. The `t=` param versions the URL so a changed avatar busts
  // both this cache and the browser's private cache.
  const sourceUrl = avatar && userId ? buildApiUrl(`/files/users/${userId}/avatar?v=thumb-20260522&t=${encodeURIComponent(avatar)}`) : undefined;
  const avatarResource = useAuthenticatedImageResource(sourceUrl);
  const avatarUrl = avatarResource.url;

  return (
    <span className={cn('relative inline-grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#FAD4D8] via-[#F6EEE7] to-peach font-semibold text-stone-800 shadow-sm ring-1 ring-white/80 dark:text-stone-900 dark:ring-white/10', sizeClass[size], className)}>
      {avatarUrl ? (
        <img alt={name} className="h-full w-full object-cover rounded-full" decoding="async" onError={avatarResource.onError} src={avatarUrl} />
      ) : (
        initial
      )}
      {role === 'admin' && (
        <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-accent text-white ring-2 ring-white dark:ring-night-surface z-30">
          <ShieldCheck className="h-3 w-3" />
        </span>
      )}
    </span>
  );
}
