import jest from 'eslint-plugin-jest';

export default [
  {
    files: ['tests/**/*.js', 'tests/**/*.test.js'],
    plugins: { jest },
    rules: {
      'jest/no-disabled-tests': 'error',
    },
  },
];
