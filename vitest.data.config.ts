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
      include: [
        'server-account-store.mjs',
        'server-persistence-health.mjs',
        'server-room-persistence.mjs',
        'server-readiness.mjs',
        'server-release.mjs',
        'server-state-backup.mjs'
      ],
      thresholds: {
        lines: 88,
        branches: 62,
        functions: 90,
        statements: 80,
        'server-account-store.mjs': {
          lines: 90,
          branches: 85,
          functions: 95,
          statements: 85
        },
        'server-persistence-health.mjs': {
          lines: 90,
          branches: 85,
          functions: 95,
          statements: 85
        },
        'server-readiness.mjs': {
          lines: 90,
          branches: 85,
          functions: 95,
          statements: 85
        },
        'server-release.mjs': {
          lines: 90,
          branches: 85,
          functions: 95,
          statements: 85
        },
        'server-room-persistence.mjs': {
          lines: 90,
          branches: 85,
          functions: 95,
          statements: 85
        },
        'server-state-backup.mjs': {
          lines: 90,
          branches: 85,
          functions: 95,
          statements: 85
        }
      }
    }
  }
});
