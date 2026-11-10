import type { FormEvent, ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '../../../shared/components/Button';
import type { OAuthProvider, OAuthProviders, RegisterWithInvitationParams } from '../services/authService';

type AuthPanelMode = 'login' | 'register';

interface LoginPanelProps {
  errorMessage: string;
  isSubmitting: boolean;
  onLoginSubmit: (params: { email: string; password: string }) => Promise<void>;
  onRegisterSubmit: (params: RegisterWithInvitationParams) => Promise<void>;
  oauthProviders?: OAuthProviders;
  onOAuthStart?: (provider: OAuthProvider) => void;
}

export function LoginPanel({ errorMessage, isSubmitting, onLoginSubmit, onRegisterSubmit, oauthProviders, onOAuthStart }: LoginPanelProps) {
  const [email, setEmail] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [mode, setMode] = useState<AuthPanelMode>('login');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [showEmailForm, setShowEmailForm] = useState(false);

  const isRegister = mode === 'register';
  const hasOAuth = Boolean(!isRegister && onOAuthStart && (oauthProviders?.google || oauthProviders?.discord));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isRegister) {
      await onLoginSubmit({ email, password });
      return;
    }

    await onRegisterSubmit({ email, invitationCode, nickname, password });
  }

  function openRegister() {
    setMode('register');
    setShowEmailForm(true);
  }

  function backToLogin() {
    setMode('login');
    setShowEmailForm(false);
  }

  return (
    <div className="w-full">
      {isRegister ? (
        <div className="mb-7 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-[0.12em] text-ink dark:text-night-ink">创建账号</h2>
          <button className="text-xs text-sky-600 transition hover:text-sky-700 dark:text-accent-soft dark:hover:text-peach" onClick={backToLogin} type="button">
            返回登录
          </button>
        </div>
      ) : (
        <div className="mb-7 text-center">
          <p className="text-[11px] tracking-[0.18em] text-ink/45 dark:text-night-soft/75">选择登录方式</p>
        </div>
      )}

      {!isRegister && hasOAuth && (
        <>
          <div className="space-y-3">
            {oauthProviders?.google && (
              <OAuthButton disabled={isSubmitting} onClick={() => onOAuthStart?.('google')} provider="google">
                使用 Google 继续
              </OAuthButton>
            )}
            {oauthProviders?.discord && (
              <OAuthButton disabled={isSubmitting} onClick={() => onOAuthStart?.('discord')} provider="discord">
                使用 Discord 继续
              </OAuthButton>
            )}
          </div>

          <Divider>其他登录方式</Divider>
        </>
      )}

      {!isRegister && !showEmailForm && (
        <button className="auth-outline-button" onClick={() => setShowEmailForm(true)} type="button">
          <span className="auth-button-icon">✉</span>
          使用邮箱继续
        </button>
      )}

      {(isRegister || showEmailForm) && (
        <form className="w-full" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <Field label="邮箱">
              <input
                autoComplete="email"
                className="auth-input"
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                required
                type="email"
                value={email}
              />
            </Field>

            {isRegister && (
              <>
                <Field label="昵称">
                  <input
                    autoComplete="nickname"
                    className="auth-input"
                    onChange={(event) => setNickname(event.target.value)}
                    placeholder="你的昵称"
                    required
                    type="text"
                    value={nickname}
                  />
                </Field>
                <Field hint="每个邀请码仅可使用一次" label="邀请码">
                  <input
                    autoComplete="off"
                    className="auth-input font-mono uppercase tracking-[0.25em]"
                    onChange={(event) => setInvitationCode(event.target.value)}
                    placeholder="XXXX-XXXX"
                    required
                    type="text"
                    value={invitationCode}
                  />
                </Field>
              </>
            )}

            <Field label="密码">
              <input
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                className="auth-input"
                onChange={(event) => setPassword(event.target.value)}
                placeholder={isRegister ? '设置密码' : '输入密码'}
                required
                type="password"
                value={password}
              />
            </Field>
          </div>

          {errorMessage && (
            <p className="mt-5 border-l-2 border-red-400 pl-3 text-xs leading-relaxed text-red-600 dark:border-red-300 dark:text-red-300" role="alert">
              {errorMessage}
            </p>
          )}

          <Button className="mt-6 h-12 w-full rounded-full tracking-[0.1em]" disabled={isSubmitting} type="submit">
            {isSubmitting ? '正在处理…' : isRegister ? '创建账号' : '登录'}
          </Button>
        </form>
      )}

      {!isRegister && errorMessage && !showEmailForm && (
        <p className="mt-5 border-l-2 border-red-400 pl-3 text-xs leading-relaxed text-red-600 dark:border-red-300 dark:text-red-300" role="alert">
          {errorMessage}
        </p>
      )}

      {!isRegister && (
        <p className="mt-8 text-center text-xs text-ink/50 dark:text-night-soft/80">
          还没有账号？{' '}
          <button className="font-medium text-sky-600 underline-offset-4 transition hover:text-sky-700 hover:underline dark:text-accent-soft dark:hover:text-peach" onClick={openRegister} type="button">
            注册一个
          </button>
        </p>
      )}
    </div>
  );
}

function OAuthButton({ children, disabled, onClick, provider }: { children: ReactNode; disabled: boolean; onClick: () => void; provider: OAuthProvider }) {
  return (
    <button className="auth-outline-button" disabled={disabled} onClick={onClick} type="button">
      <span className={`auth-button-icon auth-button-icon-${provider}`} aria-hidden>
        {provider === 'google' ? 'G' : '◈'}
      </span>
      {children}
    </button>
  );
}

function Divider({ children }: { children: ReactNode }) {
  return (
    <div className="my-7 flex items-center gap-3 text-[10px] tracking-[0.16em] text-ink/35 dark:text-night-soft/55">
      <span className="h-px flex-1 bg-current opacity-30" />
      <span>{children}</span>
      <span className="h-px flex-1 bg-current opacity-30" />
    </div>
  );
}

function Field({ children, hint, label }: { children: ReactNode; hint?: string; label: string }) {
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline justify-between px-1">
        <span className="text-[11px] font-medium tracking-[0.12em] text-ink/60 dark:text-night-soft/85">{label}</span>
        {hint && <span className="text-[10px] tracking-wide text-ink/40 dark:text-night-soft/55">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
