import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const uiThresholds = {
  lines: 75,
  branches: 65,
  functions: 70,
  statements: 75
};

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'ui',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup/ui.ts'],
    include: ['./tests/unit/ui/**/*.test.ts', './tests/unit/ui/**/*.test.tsx'],
    restoreMocks: true,
    clearMocks: true,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/ui',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/App.tsx', 'src/account.tsx', 'src/audio.ts', 'src/push.ts'],
      thresholds: {
        ...uiThresholds,
        'src/App.tsx': uiThresholds,
        'src/account.tsx': uiThresholds,
        'src/audio.ts': uiThresholds,
        'src/push.ts': uiThresholds
      }
    }
  }
});
