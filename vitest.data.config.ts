import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'data',
    environment: 'node',
    globals: true,
    include: ['./tests/unit/data/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/data',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['server-account-store.mjs', 'server-room-persistence.mjs', 'server-release.mjs'],
      thresholds: {
        lines: 88,
        branches: 62,
        functions: 90,
        statements: 80
      }
    }
  }
});
