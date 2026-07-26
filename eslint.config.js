import js from '@eslint/js';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

const hookRules = reactHooks.configs.flat.recommended.rules;

export default [
  {
    ignores: [
      'coverage',
      'dist',
      'playwright-report',
      'server-dist',
      'test-results',
      '**/*.cjs',
      '**/*.js',
      '**/*.mjs'
    ]
  },
  js.configs.recommended,
  ...typescriptEslint.configs['flat/recommended'],
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
      parser: typescriptParser,
      sourceType: 'module'
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      'no-useless-assignment': 'off',
      'react-hooks/exhaustive-deps': hookRules['react-hooks/exhaustive-deps'],
      'react-hooks/rules-of-hooks': hookRules['react-hooks/rules-of-hooks'],
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    files: [
      'playwright.config.ts',
      'vitest.*.config.ts',
      'tests/**/*.ts',
      'tests/**/*.tsx'
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  {
    files: ['tests/e2e/fixtures.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'off'
    }
  }
];
