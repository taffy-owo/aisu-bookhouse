export type UserRole = 'admin' | 'user';

export type UserSession = {
  accountNumber?: number | null;
  email?: string;
  id: string;
  nickname: string;
  role: UserRole;
  status?: string;
  avatar?: string | null;
};
