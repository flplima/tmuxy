import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import vitest from '@vitest/eslint-plugin';
import stateFieldOwnership from './eslint-rules/state-field-ownership.mjs';

export default tseslint.config(
  { ignores: ['dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      tmuxy: {
        rules: {
          'state-field-ownership': stateFieldOwnership,
        },
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      'tmuxy/state-field-ownership': 'error',
    },
  },
  // `jest/no-disabled-tests` (eslint.config.mjs) covers tests/ only, so a
  // skipped Vitest test under src/ was blocked by nothing but review. Same
  // rule, same severity, for the Vitest half of the suite.
  {
    files: ['src/**/__tests__/**/*.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    plugins: { vitest },
    rules: {
      'vitest/no-disabled-tests': 'error',
    },
  },
  {
    files: ['src/utils/richContentParser.ts', 'src/utils/debug.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  prettier,
);
