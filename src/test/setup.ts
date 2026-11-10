import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.stubEnv('VITE_USE_BACKEND_API', 'false');
});
