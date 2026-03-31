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
  // Ban tmux CLI calls in test helper files that handle user interactions.
  // Tests must exercise the real user path: browser keyboard → tmux → SSE → DOM.
  // tmuxQuery/tmuxRun bypass the rendering pipeline and hide real bugs.
  // Allowed only in: cli.js (definitions), test-setup.js (lifecycle),
  // TmuxTestSession.js (session management), consistency.js (snapshot checks).
  {
    files: ['tests/helpers/pane-ops.js', 'tests/helpers/keyboard.js'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.name='tmuxQuery']",
          message: 'tmuxQuery bypasses the rendering pipeline. Tests must verify via DOM, not tmux capture-pane.',
        },
        {
          selector: "CallExpression[callee.name='tmuxRun']",
          message: 'tmuxRun bypasses browser input. Tests must send input via browser keyboard events.',
        },
        {
          selector: "MemberExpression[object.name='require'][property.name='call']",
          message: 'Do not dynamically require cli helpers in interaction code.',
        },
      ],
    },
  },
  // Ban tmuxQuery/tmuxRun in test files themselves (the .test.js files).
  // Exceptions: tauri tests (different architecture, no browser DOM).
  {
    files: ['tests/**/*.test.js'],
    ignores: ['tests/tauri/**'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.name='tmuxQuery']",
          message: 'tmuxQuery bypasses the rendering pipeline. Use runCommand() and verify output in the DOM.',
        },
        {
          selector: "CallExpression[callee.name='tmuxRun']",
          message: 'tmuxRun bypasses browser input. Use typeInTerminal() + pressEnter() instead.',
        },
      ],
    },
  },
];
