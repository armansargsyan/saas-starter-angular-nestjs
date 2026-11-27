import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api',
  // SWC emits decorator metadata, which Nest's dependency injection needs
  // (Vitest's default transformer does not).
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { tsconfigPaths: true },
  test: {
    name: 'api',
    environment: 'node',
    watch: false,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    coverage: { reportsDirectory: '../../coverage/apps/api' },
  },
});
