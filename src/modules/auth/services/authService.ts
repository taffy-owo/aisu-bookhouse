import type { UserSession } from '../types/session';
import { ApiError, apiRequest, assertAccountScope, buildApiUrl, clearAuthStorage, getAccessToken, getAccountScope, getStoredSession, isBackendApiEnabled, setAccessToken, setStoredSession } from '../../../shared/api';
import { isAbortError } from '../../../shared/utils/abortError';

const DEFAULT_SESSION: UserSession = {
  accountNumber: 1,
  email: 'reader@example.local',
  id: 'user-001',
  nickname: '爱素',
  role: 'user',
  status: 'active',
};

type BackendUser = {
  account_number?: number | null;
  email: string;
  id: string;
  nickname: string;
  role: 'admin' | 'user';
  status: string;
  avatar?: string | null;
};

type AuthTokenResponse = {
  access_token: string;
  token_type: string;
  user: BackendUser;
};

export type OAuthProvider = 'google' | 'discord';
export type OAuthProviders = Record<OAuthProvider, boolean>;

export type RegisterWithInvitationParams = {
  email: string;
  invitationCode: string;
  nickname: string;
  password: string;
};

export async function getOAuthProviders(signal?: AbortSignal): Promise<OAuthProviders> {
  if (!isBackendApiEnabled()) {
    return { google: false, discord: false };
  }
  return apiRequest<OAuthProviders>('/auth/oauth/providers', { signal });
}

export function getOAuthStartUrl(provider: OAuthProvider): string {
  return buildApiUrl(`/auth/oauth/${provider}/start`);
}

export async function consumeOAuthTicket(ticket: string): Promise<UserSession> {
  if (!isBackendApiEnabled()) {
    throw new Error('社交登录需要连接服务器');
  }
  const tokenResponse = await apiRequest<AuthTokenResponse>('/auth/oauth/consume', {
    body: JSON.stringify({ ticket }),
    method: 'POST',
  });
  return storeAuthenticatedSession(tokenResponse);
}

export async function getCurrentSession(signal?: AbortSignal): Promise<UserSession | null> {
  const scope = getAccountScope();
  if (!isBackendApiEnabled()) {
    return getStoredSession() ?? DEFAULT_SESSION;
  }

  if (!getAccessToken()) {
    return null;
  }

  try {
    const user = await apiRequest<BackendUser>('/auth/me', { signal });
    const session = mapBackendUser(user);
    setStoredSession(session);
    return session;
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }
    if (!getAccessToken() && !getStoredSession()) return null;
    assertAccountScope(scope);
    // Only a definitive auth rejection may log the user out. A network blip
    // or a 5xx must not clear the token: fall back to the cached session so
    // the app keeps working; if the token really is dead, the next API call
    // answers 401 and the session-expired broadcast logs the user out.
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      clearAuthStorage();
      return null;
    }
    return getStoredSession();
  }
}

export async function login(email: string, password: string): Promise<UserSession> {
  if (!email.trim() || !password.trim()) {
    throw new Error('请输入邮箱和密码');
  }

  if (!isBackendApiEnabled()) {
    const session = createLocalSession(email);
    setStoredSession(session);
    return session;
  }

  const tokenResponse = await apiRequest<AuthTokenResponse>('/auth/login', {
    body: JSON.stringify({ email, password }),
    method: 'POST',
  });
  return storeAuthenticatedSession(tokenResponse);
}

export async function registerWithInvitation(params: RegisterWithInvitationParams): Promise<UserSession> {
  if (!params.email.trim() || !params.password.trim() || !params.nickname.trim() || !params.invitationCode.trim()) {
    throw new Error('请填完整注册信息');
  }

  if (!isBackendApiEnabled()) {
    const session = createLocalSession(params.email);
    setStoredSession(session);
    return session;
  }

  const tokenResponse = await apiRequest<AuthTokenResponse>('/auth/register', {
    body: JSON.stringify({
      email: params.email,
      invitation_code: params.invitationCode,
      nickname: params.nickname,
      password: params.password,
    }),
    method: 'POST',
  });
  return storeAuthenticatedSession(tokenResponse);
}

export async function logout(): Promise<void> {
  const scope = getAccountScope();
  if (isBackendApiEnabled()) {
    try {
      await apiRequest<void>('/auth/logout', { method: 'POST' });
    } catch {
      // Local logout must still complete when the server is unreachable.
    }
  }
  assertAccountScope(scope);
  clearAuthStorage();
}

export async function changePassword(currentPassword: string, newPassword: string, signal?: AbortSignal): Promise<void> {
  if (!currentPassword.trim() || !newPassword.trim()) {
    throw new Error('请输入当前密码和新密码');
  }
  if (newPassword.length < 8) {
    throw new Error('新密码至少需要 8 位');
  }

  if (!isBackendApiEnabled()) {
    return;
  }

  await apiRequest<void>('/auth/change-password', {
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
}

function storeAuthenticatedSession(tokenResponse: AuthTokenResponse): UserSession {
  const session = mapBackendUser(tokenResponse.user);
  // The old reader flushes during the session boundary while its token is
  // still available. Publish the new credentials in the same synchronous turn.
  setStoredSession(session);
  setAccessToken(tokenResponse.access_token);
  return session;
}

export async function updateProfile(nickname: string, signal?: AbortSignal): Promise<UserSession> {
  if (!nickname.trim()) {
    throw new Error('昵称不能为空');
  }

  if (!isBackendApiEnabled()) {
    const stored = getStoredSession() ?? DEFAULT_SESSION;
    const nextSession = { ...stored, nickname };
    setStoredSession(nextSession);
    return nextSession;
  }

  const user = await apiRequest<BackendUser>('/auth/me', {
    body: JSON.stringify({ nickname }),
    method: 'PUT',
    ...(signal ? { signal } : {}),
  });
  const session = mapBackendUser(user);
  setStoredSession(session);
  return session;
}

export async function uploadAvatar(file: File, signal?: AbortSignal): Promise<UserSession> {
  const scope = getAccountScope();
  if (!isBackendApiEnabled()) {
    // For local mock mode, we just simulate success with a placeholder data-url or similar
    const stored = getStoredSession() ?? DEFAULT_SESSION;
    const nextSession = { ...stored, avatar: 'mock-avatar-path' };
    setStoredSession(nextSession);
    return nextSession;
  }

  const formData = new FormData();
  formData.append('file', await prepareAvatarUploadFile(file));
  assertAccountScope(scope);
  if (signal?.aborted) throw signal.reason ?? new DOMException('上传已取消', 'AbortError');

  const user = await apiRequest<BackendUser>('/auth/me/avatar', {
    body: formData,
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
  const session = mapBackendUser(user);
  setStoredSession(session);
  return session;
}

async function prepareAvatarUploadFile(file: File): Promise<File> {
  if (file.type === 'image/gif' || typeof document === 'undefined' || typeof URL === 'undefined') {
    return file;
  }

  try {
    const image = await loadImageFromFile(file);
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.height = size;
    canvas.width = size;

    const context = canvas.getContext('2d');
    if (!context) {
      return file;
    }

    context.save();
    context.filter = 'blur(18px) saturate(1.08)';
    drawCoverImage(context, image, size, 1.18);
    context.restore();
    context.fillStyle = 'rgba(255, 255, 255, 0.08)';
    context.fillRect(0, 0, size, size);

    context.save();
    context.globalAlpha = 0.96;
    drawCoverImage(context, image, size, 0.88);
    context.restore();

    const blob = await canvasToBlob(canvas);
    if (!blob) {
      return file;
    }

    return new File([blob], 'avatar.png', { type: 'image/png' });
  } catch {
    return file;
  }
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load avatar image'));
    };
    image.src = objectUrl;
  });
}

function drawCoverImage(context: CanvasRenderingContext2D, image: HTMLImageElement, canvasSize: number, scaleMultiplier: number) {
  const imageScale = Math.max(canvasSize / image.naturalWidth, canvasSize / image.naturalHeight) * scaleMultiplier;
  const width = image.naturalWidth * imageScale;
  const height = image.naturalHeight * imageScale;
  const x = (canvasSize - width) / 2;
  const y = (canvasSize - height) / 2;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, x, y, width, height);
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
}

function mapBackendUser(user: BackendUser): UserSession {
  return {
    accountNumber: user.account_number,
    email: user.email,
    id: user.id,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    avatar: user.avatar,
  };
}

function createLocalSession(email: string): UserSession {
  return {
    email,
    accountNumber: 1,
    id: 'user-001',
    nickname: email.split('@')[0] || DEFAULT_SESSION.nickname,
    role: 'user',
    status: 'active',
  };
}
