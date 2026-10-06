import jest from 'eslint-plugin-jest';

export default [
  {
    files: ['tests/**/*.js'],
    plugins: { jest },
    rules: {
      'jest/no-disabled-tests': 'error',
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  // Ban tmux CLI calls in test helper files that handle user interactions.
  // Tests must exercise the real user path: browser keyboard → tmux → SSE → DOM.
  // tmuxExec/tmuxRun bypass the rendering pipeline and hide real bugs.
  {
    files: ['tests/helpers/pane-ops.js', 'tests/helpers/keyboard.js'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.name='tmuxExec']",
          message: 'tmuxExec bypasses the rendering pipeline. Tests must verify via DOM, not tmux capture-pane.',
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
  // Ban direct tmux calls in test files themselves (the .test.js files): input
  // goes through the browser, and the one sanctioned way to reach tmux is
  // tmuxExec() for environment setup and ground-truth reads.
  // Exceptions: tauri tests (different architecture, no browser DOM).
  {
    files: ['tests/**/*.test.js'],
    ignores: ['tests/tauri/**'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.name='tmuxCmd']",
          message:
            'Do not build tmux command lines in test files. Use runCommand() and verify output in the DOM, or tmuxExec() for setup/ground truth.',
        },
        {
          selector: "CallExpression[callee.name='tmuxRun']",
          message: 'tmuxRun bypasses browser input. Use typeInTerminal() + pressEnter() instead.',
        },
        // Direct child_process use bypasses both the user-path rule above and
        // the tmux socket isolation. Environment setup and sanctioned
        // ground-truth reads go through tmuxExec() in helpers/tmux-socket.js.
        {
          selector: "CallExpression[callee.name='execSync']",
          message:
            'Do not shell out directly from test files. Use tmuxExec() from helpers/tmux-socket.js (setup/ground-truth only) or a session helper.',
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value='child_process']",
          message:
            'Do not import child_process in test files. Use tmuxExec() from helpers/tmux-socket.js.',
        },
      ],
    },
  },
];
