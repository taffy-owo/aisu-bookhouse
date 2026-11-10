import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '../shared/theme';
import { SessionProvider } from './SessionProvider';
import { AppRoutes } from './router';
import { RouteScrollRestoration } from './RouteScrollRestoration';

export function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <SessionProvider>
          <RouteScrollRestoration />
          <AppRoutes />
        </SessionProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
