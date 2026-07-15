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
      include: [
        'src/App.tsx',
        'src/PushSettingsControls.tsx',
        'src/GameTableLayout.tsx',
        'src/accessibility.ts',
        'src/account.tsx',
        'src/audio.ts',
        'src/gamePresentation.ts',
        'src/lazyRoomConnection.ts',
        'src/pwaUpdate.ts',
        'src/pwaWorkerIdentity.ts',
        'src/push.ts',
        'src/resetRecovery.ts',
        'src/soloDurability.ts'
      ],
      thresholds: {
        ...uiThresholds,
        'src/App.tsx': uiThresholds,
        'src/PushSettingsControls.tsx': uiThresholds,
        'src/GameTableLayout.tsx': uiThresholds,
        'src/accessibility.ts': uiThresholds,
        'src/account.tsx': uiThresholds,
        'src/audio.ts': uiThresholds,
        'src/gamePresentation.ts': uiThresholds,
        'src/lazyRoomConnection.ts': uiThresholds,
        'src/pwaUpdate.ts': uiThresholds,
        'src/pwaWorkerIdentity.ts': uiThresholds,
        'src/push.ts': uiThresholds,
        'src/resetRecovery.ts': uiThresholds,
        'src/soloDurability.ts': uiThresholds
      }
    }
  }
});
