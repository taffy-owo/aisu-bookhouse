import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/artifacts/**'],
    environment: 'node',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
