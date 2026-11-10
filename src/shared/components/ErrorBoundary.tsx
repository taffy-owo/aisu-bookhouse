import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isAssetLoadError, recoverFromAssetLoadError } from '../utils/assetLoadRecovery';
import { Button } from './Button';
import { Panel } from './Panel';

export interface ErrorBoundaryFallbackProps {
  error: Error;
  isOffline: boolean;
  onRetry: () => void;
  onReload: () => void;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  description?: string;
  fullPage?: boolean;
  renderFallback?: (props: ErrorBoundaryFallbackProps) => ReactNode;
  resetKey?: string;
  title?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  isOffline: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, isOffline: typeof window !== 'undefined' && window.navigator.onLine === false };

  componentDidMount() {
    window.addEventListener('online', this.updateConnectionStatus);
    window.addEventListener('offline', this.updateConnectionStatus);
  }

  componentWillUnmount() {
    window.removeEventListener('online', this.updateConnectionStatus);
    window.removeEventListener('offline', this.updateConnectionStatus);
  }

  updateConnectionStatus = () => {
    this.setState({ isOffline: window.navigator.onLine === false });
  };

  handleRetry = () => {
    if (isAssetLoadError(this.state.error)) {
      // React.lazy retains a rejected import; rerendering cannot retry it.
      if (window.navigator.onLine !== false) window.location.reload();
      return;
    }
    this.setState({ error: null });
  };

  handleReload = () => window.location.reload();

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, 'error'> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    if (recoverFromAssetLoadError(error)) {
      return;
    }
    console.error('Aisu page render failed', error, errorInfo);
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    if (this.props.renderFallback) {
      return this.props.renderFallback({ error: this.state.error, isOffline: this.state.isOffline, onRetry: this.handleRetry, onReload: this.handleReload });
    }

    const assetLoadFailed = isAssetLoadError(this.state.error);
    const content = (
      <Panel className="mx-auto w-full max-w-2xl" role="alert">
        <div className="text-center">
          <p className="text-sm font-medium text-accent">页面暂时不可用</p>
          <h1 className="mt-3 font-display text-2xl font-semibold text-stone-950 dark:text-night-ink">
            {this.props.title ?? '这一页遇到了一点问题'}
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-stone-500 dark:text-stone-400">
            {this.props.description ?? (assetLoadFailed
              ? this.state.isOffline
                ? '网络连接已断开。连接恢复后，可以重试加载当前页面。'
                : '这一页的资源没有加载成功。点击重试，重新加载当前页面。'
              : '你可以先重试当前页面；如果仍然失败，请刷新后再进入。')}
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
            <Button disabled={assetLoadFailed && this.state.isOffline} onClick={this.handleRetry}>重试</Button>
            {!assetLoadFailed && <Button onClick={this.handleReload} variant="secondary">刷新页面</Button>}
          </div>
        </div>
      </Panel>
    );

    return this.props.fullPage
      ? <main className="grid min-h-screen place-items-center bg-paper px-4 py-10 text-ink dark:bg-night dark:text-night-copy">{content}</main>
      : content;
  }
}
