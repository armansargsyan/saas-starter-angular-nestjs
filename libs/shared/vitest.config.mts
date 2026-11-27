import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/shared',
  test: {
    name: 'shared',
    environment: 'node',
    watch: false,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    coverage: { reportsDirectory: '../../coverage/libs/shared' },
  },
});
