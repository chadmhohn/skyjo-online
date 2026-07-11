import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'delivery-security',
    environment: 'node',
    globals: true,
    include: ['./tests/unit/data/runtimeArtifact.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/delivery',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['scripts/runtime-artifact-security.mjs'],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 80
      }
    }
  }
});
