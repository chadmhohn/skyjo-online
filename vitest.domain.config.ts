import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'domain',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup/dom.ts'],
    include: ['./tests/unit/domain/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/domain',
      reporter: ['text', 'json-summary', 'lcov'],
      include: [
        'src/aiStrategy.ts',
        'src/aiProjection.ts',
        'src/game.ts',
        'src/gameRules.ts',
        'src/runtime.ts',
        'src/serverValidation.ts',
        'src/soloAiSetup.ts',
        'src/soloAiOpening.ts'
      ],
      thresholds: {
        perFile: true,
        lines: 90,
        branches: 85,
        functions: 72,
        statements: 69
      }
    }
  }
});
