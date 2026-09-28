import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { builtinModules } from 'node:module';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'worktrees/**',
      'tmp/**',
      'reference/**',
      'tests/fixtures/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: hooks.configs.recommended.rules,
  },
  {
    files: ['tests/e2e/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@playwright/test',
              message: 'Import test and expect from ./network-fixture so every browser request is guarded.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/**/*.test.ts', 'src/core/**/__prototype__/**', 'src/core/**/__golden__/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        'Buffer',
        'process',
        'require',
        '__dirname',
        '__filename',
        'global',
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...builtinModules.filter((name) => !name.startsWith('node:')),
            'react',
            'react-dom',
          ],
          patterns: [
            'node:*',
            'react/*',
            'react-dom/*',
            '**/ui/**',
            '**/ui',
            '**/state/**',
            '**/state',
            '**/io/**',
            '**/io',
            '**/worker/**',
            '**/worker',
          ],
        },
      ],
    },
  },
);
