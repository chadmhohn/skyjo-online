import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'contracts',
    environment: 'node',
    globals: true,
    include: ['./tests/unit/contracts/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/contracts',
      reporter: ['text', 'json-summary', 'lcov']
    }
  }
});
