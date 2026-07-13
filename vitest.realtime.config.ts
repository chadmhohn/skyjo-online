import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'realtime',
    environment: 'node',
    globals: true,
    include: ['./tests/unit/realtime/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/realtime',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/roomConnection.ts', 'src/serverProtocolV1.ts', 'src/serverRealtime.ts'],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
        'src/serverRealtime.ts': {
          lines: 90,
          branches: 85,
          functions: 90,
          statements: 90
        },
        'src/serverProtocolV1.ts': {
          lines: 90,
          branches: 85,
          functions: 90,
          statements: 90
        },
        'src/roomConnection.ts': {
          lines: 90,
          branches: 85,
          functions: 90,
          statements: 90
        }
      }
    }
  }
});
