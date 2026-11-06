import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import vitest from '@vitest/eslint-plugin';
import globals from 'globals';
import stateFieldOwnership from './eslint-rules/state-field-ownership.mjs';
import noBarrelFiles from './eslint-rules/no-barrel-files.mjs';

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
          'no-barrel-files': noBarrelFiles,
        },
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'tmuxy/state-field-ownership': 'error',
      'tmuxy/no-barrel-files': 'error',
    },
  },
  // Dependencies point down the layers: domain/ (the model and the vocabulary)
  // imports nothing above it, infra/ (the platform and the transport) only
  // the domain, machines/ no component. A type or helper two layers share
  // lives in the lower one (packages/tmuxy-ui/README.md). A test may reach
  // up: it drives the seam between layers.
  ...[
    { layer: 'domain', above: ['machines', 'components', 'infra', 'hooks', 'utils'] },
    { layer: 'infra', above: ['machines', 'components', 'hooks', 'utils'] },
    { layer: 'machines', above: ['components', 'hooks', 'utils'] },
  ].map(({ layer, above }) => ({
    files: [`src/${layer}/**/*.{ts,tsx}`],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `^(\\.\\./)+(${above.join('|')})(/|$)`,
              message: `${layer}/ is below ${above.join(', ')}: move what it needs down instead.`,
            },
          ],
        },
      ],
    },
  })),
  // The scripts under scripts/ and the lint rules under eslint-rules/ run in
  // Node (`npm run lint` covers them, with src); the probe and perf scripts
  // also evaluate code inside the page, hence the browser globals too.
  {
    files: ['scripts/**/*.mjs', 'eslint-rules/*.mjs', '.storybook/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  // The root eslint.config.mjs applies `jest/no-disabled-tests` to tests/ only;
  // the same rule, same severity, for the Vitest half of the suite.
  {
    files: [
      'src/**/__tests__/**/*.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'src/test/**/*.{ts,tsx}',
      'scripts/**/*.test.mjs',
    ],
    plugins: { vitest },
    rules: {
      'vitest/no-disabled-tests': 'error',
    },
  },
  prettier,
);
