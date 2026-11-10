import { useEffect, useState } from 'react';
import { BrandWordmark } from '../../../shared/components';
import { LoginPanel } from '../components/LoginPanel';
import { getOAuthProviders, getOAuthStartUrl, type OAuthProvider, type OAuthProviders, type RegisterWithInvitationParams } from '../services/authService';
import type { UserSession } from '../types/session';
import { rememberOAuthReturnLocation, type LoginReturnLocation } from '../services/loginReturnLocation';

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<UserSession>;
  onRegister: (params: RegisterWithInvitationParams) => Promise<UserSession>;
  returnLocation?: LoginReturnLocation;
}

export function LoginPage({ onLogin, onRegister, returnLocation }: LoginPageProps) {
  const [errorMessage, setErrorMessage] = useState(readOAuthErrorMessage);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviders>({ google: false, discord: false });

  useEffect(() => {
    const controller = new AbortController();
    void getOAuthProviders(controller.signal).then((providers) => {
      if (!controller.signal.aborted) setOAuthProviders(providers);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function handleLogin(params: { email: string; password: string }) {
    await submitAuthAction(() => onLogin(params.email, params.password));
  }

  async function handleRegister(params: RegisterWithInvitationParams) {
    await submitAuthAction(() => onRegister(params));
  }

  async function submitAuthAction(authenticate: () => Promise<UserSession>) {
    setIsSubmitting(true);
    setErrorMessage('');

    try {
      await authenticate();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '操作失败');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleOAuthStart(provider: OAuthProvider) {
    setIsSubmitting(true);
    rememberOAuthReturnLocation(returnLocation);
    window.location.assign(getOAuthStartUrl(provider));
  }

  function readOAuthErrorMessage() {
    const code = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('oauth_error');
    if (!code) return '';
    const messages: Record<string, string> = {
      account_disabled: '这个账号已被停用。',
      account_link_conflict: '社交账号绑定发生冲突，请联系管理员。',
      account_not_linked: '该邮箱尚未绑定书屋账号，请先使用邮箱密码登录或联系管理员。',
      invalid_oauth_state: '登录验证已过期，请重新尝试。',
      provider_cancelled: '你取消了社交登录。',
      provider_email_missing: '社交账号没有返回可用邮箱。',
      provider_email_unverified: '请先验证社交账号邮箱。',
      provider_not_configured: '该社交登录尚未配置完成。',
      provider_unavailable: '社交登录服务暂时不可用，请稍后重试。',
      login_failed: '社交登录失败，请重新尝试。',
    };
    return messages[code] ?? '社交登录失败，请重新尝试。';
  }

  return (
    <main className="auth-simple min-h-screen w-full bg-paper text-ink dark:bg-[#171416] dark:text-night-copy">
      <div className="mx-auto flex min-h-screen w-full max-w-[430px] flex-col items-center px-6 py-10 sm:py-14">
        <BrandWordmark className="flex-col gap-3" />
        <p className="mt-3 text-xs tracking-[0.12em] text-ink/45 dark:text-night-soft/75">登录以继续阅读</p>

        <div className="mt-8 w-full">
          <LoginPanel
            errorMessage={errorMessage}
            isSubmitting={isSubmitting}
            onLoginSubmit={handleLogin}
            onRegisterSubmit={handleRegister}
            oauthProviders={oauthProviders}
            onOAuthStart={handleOAuthStart}
          />
        </div>

        <p className="mt-10 text-center text-[10px] leading-relaxed tracking-wide text-ink/35 dark:text-night-soft/55">
          登录即表示你同意爱素书屋的服务条款与隐私政策
        </p>
      </div>
    </main>
  );
}
