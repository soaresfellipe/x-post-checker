import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.output/**', '.wxt/**', 'build/**', 'node_modules/**', 'research/**', 'test-results/**', 'playwright-report/**', 'web-ext-artifacts/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs', 'test/**/*.ts', '*.ts', '*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Node scripts whose page.evaluate callbacks run in the BROWSER context (real-x inspection,
    // the real-x smoke harness, and the m5-overlay-scroll-reach live probes).
    files: [
      'scripts/real-x-inspect.mjs',
      'scripts/real-x-smoke.mjs',
      'scripts/overlay-scroll-probe.mjs',
      'scripts/real-x-dom-survey.mjs',
      'scripts/real-x-insertion-probe.mjs',
      'scripts/real-x-dropdown-stacking-probe.mjs',
      'scripts/theme-interactive-verify.mjs',
    ],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
