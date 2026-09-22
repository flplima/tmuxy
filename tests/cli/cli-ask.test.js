const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy ask` is the confirmation half of `tmuxy pane send`: it hangs a
 * question on the target pane and blocks until a client answers it, so the
 * caller learns when the command actually started.
 *
 * The mock tmux plays the client — it recovers the token from the base64
 * payload the script wrote and answers with it, exactly as the UI does. That
 * keeps these tests on the real protocol rather than on an injected token.
 */

/** The base64 `@tmuxy-ask` payload from the run-shell calls, decoded. */
function askPayload(tmuxCalls) {
  const write = tmuxCalls
    .map((call) => call.args.join(' '))
    .reverse()
    .find((line) => /@tmuxy-ask '/.test(line));
  if (!write) return null;
  const encoded = write.match(/@tmuxy-ask '([A-Za-z0-9+/=]*)'/)[1];
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

/** Every run-shell command string the CLI issued, in order. */
function runShellCommands(tmuxCalls) {
  return tmuxCalls.filter((call) => call.args[0] === 'run-shell').map((call) => call.args[1]);
}

describe('tmuxy ask', () => {
  describe('the question it hangs on the pane', () => {
    test('defaults to the keys it is about to send', () => {
      const { exitCode, tmuxCalls } = runCLI(['ask', '%3', 'npm test', 'Enter'], {
        env: { MOCK_TMUX_ANSWER: 'yes' },
      });
      expect(exitCode).toBe(0);
      const payload = askPayload(tmuxCalls);
      expect(payload.question).toBe('Do you want to send keys "npm test Enter"?');
      expect(payload.description).toBe('');
      expect(payload.token).toMatch(/^3-\d+$/);
    });

    test('carries --question and --description verbatim', () => {
      const { exitCode, tmuxCalls } = runCLI(
        [
          'ask',
          '%3',
          'make deploy',
          'Enter',
          '--question',
          'Deploy to production?',
          '--description',
          'Builds, uploads, and restarts the web tier.',
        ],
        { env: { MOCK_TMUX_ANSWER: 'yes' } },
      );
      expect(exitCode).toBe(0);
      const payload = askPayload(tmuxCalls);
      expect(payload.question).toBe('Deploy to production?');
      expect(payload.description).toBe('Builds, uploads, and restarts the web tier.');
    });

    test('survives a question full of the characters that break list-panes', () => {
      // A comma would shift every field after it in the comma-separated
      // list-panes row, and a quote would break the JSON — which is exactly
      // why the payload is JSON inside base64.
      const question = 'Run "build, test, deploy"? It\'s the full pipeline.';
      const { exitCode, tmuxCalls } = runCLI(['ask', '%3', 'make all', '--question', question], {
        env: { MOCK_TMUX_ANSWER: 'yes' },
      });
      expect(exitCode).toBe(0);
      expect(askPayload(tmuxCalls).question).toBe(question);
    });
  });

  describe('answering', () => {
    test('yes sends the keys and clears the question first', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['ask', '%3', 'npm test', 'Enter'], {
        env: { MOCK_TMUX_ANSWER: 'yes' },
      });
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('yes');

      const commands = runShellCommands(tmuxCalls);
      const sendIndex = commands.findIndex((cmd) => cmd.includes('send-keys'));
      const clearIndex = commands.findIndex((cmd) =>
        /set-option -pu -t '%3' @tmuxy-ask$/.test(cmd),
      );
      expect(sendIndex).toBeGreaterThan(-1);
      expect(commands[sendIndex]).toContain("send-keys -t '%3' 'npm test' 'Enter'");
      // The overlay comes down before the keys land, so the user never watches
      // the command being typed underneath a stale question.
      expect(clearIndex).toBeLessThan(sendIndex);
    });

    test('no sends nothing and exits 1', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['ask', '%3', 'rm -rf dist', 'Enter'], {
        env: { MOCK_TMUX_ANSWER: 'no' },
      });
      expect(exitCode).toBe(1);
      expect(stdout.trim()).toBe('no');
      expect(runShellCommands(tmuxCalls).some((cmd) => cmd.includes('send-keys'))).toBe(false);
    });

    test('clears a stale answer before asking', () => {
      // Otherwise the previous question's answer would be read as this one's
      // on the very first poll.
      const { tmuxCalls } = runCLI(['ask', '%3', 'ls'], { env: { MOCK_TMUX_ANSWER: 'yes' } });
      const commands = runShellCommands(tmuxCalls);
      const clearAnswer = commands.findIndex((cmd) =>
        /set-option -pu -t '%3' @tmuxy-ask-answer$/.test(cmd),
      );
      const setQuestion = commands.findIndex((cmd) => /@tmuxy-ask '/.test(cmd));
      expect(clearAnswer).toBeGreaterThan(-1);
      expect(clearAnswer).toBeLessThan(setQuestion);
    });
  });

  describe('refusals', () => {
    test('needs a target pane', () => {
      const { exitCode, stderr } = runCLI(['ask', 'npm test']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('target pane required');
    });

    test('needs keys to send', () => {
      const { exitCode, stderr } = runCLI(['ask', '%3']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('keys required');
    });

    test('rejects a non-numeric timeout', () => {
      const { exitCode, stderr } = runCLI(['ask', '%3', 'ls', '--timeout', 'soon']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('--timeout');
    });

    test('gives up when the question is never answered', () => {
      // No MOCK_TMUX_ANSWER: the option stays empty, as it does while the
      // question sits unanswered on screen.
      const { exitCode, stderr, tmuxCalls } = runCLI(['ask', '%3', 'ls', '--timeout', '1']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('timed out');
      // The question must not outlive the asker.
      expect(
        runShellCommands(tmuxCalls).some((cmd) => /set-option -pu -t '%3' @tmuxy-ask$/.test(cmd)),
      ).toBe(true);
    });
  });

  test('--help explains itself without touching tmux', () => {
    const { stdout, exitCode, tmuxCalls } = runCLI(['ask', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy ask');
    expect(tmuxCalls).toHaveLength(0);
  });
});
