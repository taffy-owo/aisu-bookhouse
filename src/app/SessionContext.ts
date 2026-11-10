import { createContext, useContext } from 'react';
import type { RegisterWithInvitationParams } from '../modules/auth/services/authService';
import type { UserSession } from '../modules/auth/types/session';

export interface SessionContextValue {
  isLoading: boolean;
  login: (email: string, password: string) => Promise<UserSession>;
  logout: () => Promise<void>;
  registerWithInvitation: (params: RegisterWithInvitationParams) => Promise<UserSession>;
  session: UserSession | null;
  updateNickname: (nickname: string, signal?: AbortSignal) => Promise<void>;
  updateAvatar: (file: File, signal?: AbortSignal) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string, signal?: AbortSignal) => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession() {
  const context = useContext(SessionContext);

  if (!context) {
    throw new Error('useSession must be used inside SessionProvider');
  }

  return context;
}
