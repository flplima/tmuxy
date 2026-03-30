import jest from 'eslint-plugin-jest';

export default [
  {
    files: ['tests/**/*.js', 'tests/**/*.test.js'],
    ignores: ['tests/qa-snapshot.js', 'tests/qa-performance.js'],
    plugins: { jest },
    rules: {
      'jest/no-disabled-tests': 'error',
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
];
