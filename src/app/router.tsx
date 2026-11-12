import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { ROUTES } from '../config/routes';
import { EmptyState } from '../shared/components/EmptyState';
import { ErrorBoundary } from '../shared/components/ErrorBoundary';
import { LinkButton } from '../shared/components/LinkButton';
import { AppLayout } from './AppLayout';
import { useSession } from './SessionContext';
import { createLocationResetKey } from './locationResetKey';
import { ReaderErrorBoundary } from '../modules/reader/components/ReaderErrorBoundary';
import { ReaderStartupState } from '../modules/reader/components/ReaderStartupState';
import { readReaderPreferences } from '../modules/reader/services/readerPreferences';
import { applyReaderBrowserChromeTheme } from '../modules/reader/services/readerBrowserChrome';
import { readOAuthReturnLocation, rememberOAuthReturnLocation, type LoginReturnLocation } from '../modules/auth/services/loginReturnLocation';

const AdminStatusPage = lazy(() => import('../modules/admin/pages/AdminStatusPage').then((module) => ({ default: module.AdminStatusPage })));
const ApiDocsPage = lazy(() => import('../modules/settings/pages/ApiDocsPage').then((module) => ({ default: module.ApiDocsPage })));
const BookDetailPage = lazy(() => import('../modules/library/pages/BookDetailPage').then((module) => ({ default: module.BookDetailPage })));
const HomePage = lazy(() => import('../modules/library/pages/HomePage').then((module) => ({ default: module.HomePage })));
const LibraryPage = lazy(() => import('../modules/library/pages/LibraryPage').then((module) => ({ default: module.LibraryPage })));
const JapaneseReadingPage = lazy(() => import('../modules/japanese/pages/JapaneseReadingPage').then((module) => ({ default: module.JapaneseReadingPage })));
const LoginPage = lazy(() => import('../modules/auth/pages/LoginPage').then((module) => ({ default: module.LoginPage })));
const MangaReaderPage = lazy(() => import('../modules/reader/pages/MangaReaderPage').then((module) => ({ default: module.MangaReaderPage })));
const NovelReaderPage = lazy(() => import('../modules/reader/pages/NovelReaderPage').then((module) => ({ default: module.NovelReaderPage })));
const ProfilePage = lazy(() => import('../modules/profile/pages/ProfilePage').then((module) => ({ default: module.ProfilePage })));
const PublicLibraryPage = lazy(() => import('../modules/library/pages/PublicLibraryPage').then((module) => ({ default: module.PublicLibraryPage })));
const SettingsPage = lazy(() => import('../modules/settings/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const UploadPage = lazy(() => import('../modules/uploads/pages/UploadPage').then((module) => ({ default: module.UploadPage })));
const TranslationPage = lazy(() => import('../modules/uploads/pages/TranslationPage').then((module) => ({ default: module.TranslationPage })));

function LoginRoute() {
  const { isLoading, login, registerWithInvitation, session } = useSession();
  const location = useLocation();
  const [oauthReturnLocation] = useState(readOAuthReturnLocation);
  const returnLocation = (location.state as { from?: LoginReturnLocation } | null)?.from ?? oauthReturnLocation;
  useEffect(() => {
    if (session) rememberOAuthReturnLocation();
  }, [session]);

  if (isLoading) {
    return <main className="app-route-fallback grid min-h-screen place-items-center bg-paper text-sm text-stone-500 dark:bg-night dark:text-night-soft">正在连接爱素书屋...</main>;
  }

  if (session) {
    return <Navigate replace state={returnLocation?.state} to={returnLocation ?? ROUTES.home} />;
  }

  return <RouteSuspense><LoginPage onLogin={login} onRegister={registerWithInvitation} returnLocation={returnLocation} /></RouteSuspense>;
}

function ReaderRouteLoading() {
  const { bookId } = useParams();
  const { pathname } = useLocation();
  const theme = pathname.startsWith('/reader/manga/') ? 'dark' : readReaderPreferences().theme;
  useEffect(() => applyReaderBrowserChromeTheme(theme), [theme]);
  return <ReaderStartupState bookId={bookId} status="loading" theme={theme} />;
}

function RouteSuspense({ children, reader = false }: { children: ReactNode; reader?: boolean }) {
  const location = useLocation();
  const fallback = reader
    ? <ReaderRouteLoading />
    : <main className="app-route-fallback grid min-h-screen place-items-center bg-paper text-sm text-stone-500 dark:bg-night dark:text-night-soft">正在加载...</main>;
  const content = <Suspense fallback={fallback}>{children}</Suspense>;
  return reader ? <ReaderErrorBoundary>{content}</ReaderErrorBoundary> : <ErrorBoundary fullPage resetKey={createLocationResetKey(location)}>{content}</ErrorBoundary>;
}

function PageRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="app-route-fallback rounded-2xl border border-stone-200/70 bg-cream/80 px-4 py-6 text-sm text-stone-500 shadow-soft dark:border-white/10 dark:bg-night-surface/80 dark:text-stone-400">正在加载...</div>}>{children}</Suspense>;
}

function ProtectedLayoutRoute() {
  const { isLoading, session } = useSession();
  const location = useLocation();

  if (isLoading) {
    return <main className="app-route-fallback grid min-h-screen place-items-center bg-paper text-sm text-stone-500 dark:bg-night dark:text-night-soft">正在连接爱素书屋...</main>;
  }

  if (!session) {
    return <Navigate replace state={{ from: location }} to={ROUTES.login} />;
  }

  return <AppLayout />;
}

function ProtectedReaderRoute({ children }: { children: ReactNode }) {
  const { isLoading, session } = useSession();
  const location = useLocation();

  if (isLoading) {
    return <ReaderRouteLoading />;
  }

  if (!session) {
    return <Navigate replace state={{ from: location }} to={ROUTES.login} />;
  }

  return <RouteSuspense reader>{children}</RouteSuspense>;
}

function NotFoundRoute() {
  return (
    <main className="grid min-h-screen place-items-center bg-shell px-4 py-10 dark:bg-night">
      <div className="w-full max-w-2xl">
        <EmptyState
          action={<LinkButton to={ROUTES.library}>回到书架</LinkButton>}
          title="页面不存在"
        />
      </div>
    </main>
  );
}

function AdminRoute({ children }: { children: ReactNode }) {
  const { isLoading, session } = useSession();
  const location = useLocation();

  if (isLoading) {
    return <main className="app-route-fallback grid min-h-screen place-items-center bg-paper text-sm text-stone-500 dark:bg-night dark:text-night-soft">正在连接爱素书屋...</main>;
  }

  if (!session) {
    return <Navigate replace state={{ from: location }} to={ROUTES.login} />;
  }

  if (session.role !== 'admin') {
    return <Navigate replace to={ROUTES.settings} />;
  }

  return children;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<LoginRoute />} path={ROUTES.login} />
      <Route element={<ProtectedLayoutRoute />}>
        <Route element={<PageRoute><HomePage /></PageRoute>} path={ROUTES.home} />
        <Route element={<PageRoute><LibraryPage /></PageRoute>} path={ROUTES.library} />
        <Route element={<PageRoute><JapaneseReadingPage /></PageRoute>} path={ROUTES.japanese} />
        <Route element={<PageRoute><PublicLibraryPage /></PageRoute>} path={ROUTES.publicLibrary} />
        <Route element={<PageRoute><BookDetailPage /></PageRoute>} path="/books/:bookId" />
        <Route element={<PageRoute><ProfilePage /></PageRoute>} path={ROUTES.profile} />
        <Route element={<PageRoute><UploadPage /></PageRoute>} path={ROUTES.upload} />
        <Route element={<PageRoute><TranslationPage /></PageRoute>} path={ROUTES.translations} />
        <Route element={<PageRoute><ApiDocsPage /></PageRoute>} path={ROUTES.apiDocs} />
        <Route element={<PageRoute><SettingsPage /></PageRoute>} path={ROUTES.settings} />
        <Route element={<AdminRoute><PageRoute><AdminStatusPage /></PageRoute></AdminRoute>} path={ROUTES.adminUsers} />
      </Route>
      <Route element={<ProtectedReaderRoute><NovelReaderPage /></ProtectedReaderRoute>} path="/reader/novel/:bookId" />
      <Route element={<ProtectedReaderRoute><MangaReaderPage /></ProtectedReaderRoute>} path="/reader/manga/:bookId" />
      <Route element={<NotFoundRoute />} path="*" />
    </Routes>
  );
}
