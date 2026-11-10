import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { consumeOAuthTicket, getCurrentSession, login, logout, registerWithInvitation, updateProfile, uploadAvatar, changePassword, type RegisterWithInvitationParams } from '../modules/auth/services/authService';
import type { UserSession } from '../modules/auth/types/session';
import { getAccountScope, SESSION_EXPIRED_EVENT } from '../shared/api';
import { resumePendingReadingProgressSyncs } from '../modules/reader/services/readingProgressSync';
import { SessionContext, type SessionContextValue } from './SessionContext';

interface SessionProviderProps {
  children: ReactNode;
}

function clearOAuthQuery(error?: string) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('oauth_ticket');
  if (error) url.searchParams.set('oauth_error', error);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export function SessionProvider({ children }: SessionProviderProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [session, setSession] = useState<UserSession | null>(null);
  const observedScope = useRef(getAccountScope());

  useEffect(() => {
    observedScope.current = getAccountScope();
  }, [session]);

  useEffect(() => {
    let isMounted = true;
    let requestId = 0;
    let requestController: AbortController | null = null;

    async function loadSession() {
      const currentRequest = ++requestId;
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      let nextSession: UserSession | null;
      const oauthTicket = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('oauth_ticket') : null;
      if (oauthTicket) {
        try {
          nextSession = await consumeOAuthTicket(oauthTicket);
          clearOAuthQuery();
        } catch {
          nextSession = await getCurrentSession(controller.signal).catch(() => null);
          clearOAuthQuery('login_failed');
        }
      } else {
        nextSession = await getCurrentSession(controller.signal).catch(() => null);
      }

      if (isMounted && currentRequest === requestId) {
        observedScope.current = getAccountScope();
        setSession(nextSession);
        setIsLoading(false);
        if (nextSession) {
          resumePendingReadingProgressSyncs();
        }
      }
      if (requestController === controller) requestController = null;
    }

    void loadSession();
    const syncOtherTab = (event: StorageEvent) => {
      if (event.key !== null && !['aisu-bookhouse:session', 'aisu-bookhouse:access-token'].includes(event.key)) return;
      const nextScope = getAccountScope();
      const accountChanged = observedScope.current !== nextScope;
      observedScope.current = nextScope;
      // A second tab can update the nickname, avatar, or token without
      // changing the account scope. Refresh the session for those events too;
      // only clear the current UI immediately when the account itself changed.
      if (accountChanged) setSession(null);
      setIsLoading(true);
      void loadSession();
    };
    window.addEventListener('storage', syncOtherTab);

    return () => {
      isMounted = false;
      requestController?.abort();
      requestController = null;
      window.removeEventListener('storage', syncOtherTab);
    };
  }, []);

  useEffect(() => {
    // Any API 401 clears auth storage and fires this event; dropping the
    // in-memory session here lets route guards redirect to login instead of
    // leaving the user in a zombie session where every write silently fails.
    const handleSessionExpired = () => {
      setSession(null);
    };

    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);

    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      isLoading,
      async login(email: string, password: string) {
        const nextSession = await login(email, password);
        setSession(nextSession);
        resumePendingReadingProgressSyncs();
        return nextSession;
      },
      async logout() {
        await logout();
        setSession(null);
      },
      async registerWithInvitation(params: RegisterWithInvitationParams) {
        const nextSession = await registerWithInvitation(params);
        setSession(nextSession);
        resumePendingReadingProgressSyncs();
        return nextSession;
      },
      session,
      async updateNickname(nickname: string, signal?: AbortSignal) {
        const nextSession = await updateProfile(nickname, signal);
        setSession(nextSession);
      },
      async updateAvatar(file: File, signal?: AbortSignal) {
        const nextSession = await uploadAvatar(file, signal);
        setSession(nextSession);
      },
      async changePassword(currentPassword: string, newPassword: string, signal?: AbortSignal) {
        await changePassword(currentPassword, newPassword, signal);
      },
    }),
    [isLoading, session],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
