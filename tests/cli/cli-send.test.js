const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy pane send -t <pane>` into a pane the caller does not own asks first:
 * it hangs a question on the target pane and blocks until a client answers
 * it, so the caller learns when the command actually started.
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

/** The environment of a caller running in pane %1. */
const IN_PANE_1 = { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%1' };

const send = (args, env = {}) => runCLI(['pane', 'send', ...args], { env });

describe('tmuxy pane send', () => {
  describe('into the caller’s own pane', () => {
    test('with no target the keys go at once', () => {
      const { exitCode, tmuxCalls } = send(['ls', 'Enter']);
      expect(exitCode).toBe(0);
      expect(runShellCommands(tmuxCalls)).toEqual(["tmux -L tmuxy send-keys 'ls' 'Enter'"]);
      expect(askPayload(tmuxCalls)).toBeNull();
    });

    test('naming its own pane asks nothing either', () => {
      const { exitCode, tmuxCalls, stdout } = send(['-t', '%1', 'ls', 'Enter'], IN_PANE_1);
      expect(exitCode).toBe(0);
      expect(askPayload(tmuxCalls)).toBeNull();
      expect(runShellCommands(tmuxCalls).some((cmd) => cmd.includes("send-keys -t '%1'"))).toBe(
        true,
      );
      expect(stdout).toContain('sent to %1');
    });
  });

  describe('the question it hangs on another pane', () => {
    test('names the caller and carries the keys verbatim', () => {
      // A comma would shift every field after it in the comma-separated
      // list-panes row, and a quote would break the JSON — which is exactly
      // why the payload is JSON inside base64.
      const keys = ['echo "build, test, deploy"', 'Enter'];
      const { exitCode, tmuxCalls } = send(['-t', '%3', ...keys], {
        MOCK_TMUX_ANSWER: 'yes',
      });
      expect(exitCode).toBe(0);
      const payload = askPayload(tmuxCalls);
      expect(payload.keys).toEqual(keys);
      expect(payload.caller).toBeTruthy();
      expect(payload.token).toMatch(/^3-\d+$/);
    });

    test('marks the caller’s pane as waiting on the user, then puts back what it said', () => {
      const { tmuxCalls } = send(['-t', '%3', 'ls', 'Enter'], {
        ...IN_PANE_1,
        MOCK_TMUX_ANSWER: 'yes',
        MOCK_TMUX_PANE_STATE: 'working',
      });
      const commands = runShellCommands(tmuxCalls);
      const waiting = commands.findIndex((cmd) =>
        cmd.endsWith("set-option -p -t '%1' @tmuxy-pane-state needs-input"),
      );
      const restored = commands.findIndex((cmd) =>
        cmd.endsWith("set-option -p -t '%1' @tmuxy-pane-state 'working'"),
      );
      expect(waiting).toBeGreaterThan(-1);
      expect(restored).toBeGreaterThan(waiting);
    });
  });

  describe('answering', () => {
    test('yes sends the keys and clears the question first', () => {
      const { stdout, exitCode, tmuxCalls } = send(['-t', '%3', 'npm test', 'Enter'], {
        MOCK_TMUX_ANSWER: 'yes',
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('sent to %3: npm test Enter');

      const commands = runShellCommands(tmuxCalls);
      const sendIndex = commands.findIndex((cmd) => cmd.includes('send-keys'));
      const clearIndex = commands.findIndex((cmd) =>
        /set-option -pu -t '%3' @tmuxy-ask$/.test(cmd),
      );
      expect(commands[sendIndex]).toContain("send-keys -t '%3' 'npm test' 'Enter'");
      // The overlay comes down before the keys land, so the user never watches
      // the command being typed underneath a stale question.
      expect(clearIndex).toBeGreaterThan(-1);
      expect(clearIndex).toBeLessThan(sendIndex);
    });

    test('no sends nothing and exits 1', () => {
      const { stderr, exitCode, tmuxCalls } = send(['-t', '%3', 'rm -rf dist', 'Enter'], {
        MOCK_TMUX_ANSWER: 'no',
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('declined');
      expect(runShellCommands(tmuxCalls).some((cmd) => cmd.includes('send-keys'))).toBe(false);
    });

    test('clears a stale answer before asking', () => {
      // Otherwise the previous question's answer would be read as this one's
      // on the very first poll.
      const { tmuxCalls } = send(['-t', '%3', 'ls'], { MOCK_TMUX_ANSWER: 'yes' });
      const commands = runShellCommands(tmuxCalls);
      const clearAnswer = commands.findIndex((cmd) =>
        /set-option -pu -t '%3' @tmuxy-ask-answer$/.test(cmd),
      );
      const setQuestion = commands.findIndex((cmd) => /@tmuxy-ask '/.test(cmd));
      expect(clearAnswer).toBeGreaterThan(-1);
      expect(clearAnswer).toBeLessThan(setQuestion);
    });
  });

  describe('skipping the question', () => {
    test.each([
      ['@tmuxy-send-ask off', { MOCK_TMUX_SEND_ASK: 'off' }],
      ['the target on the allow list', { MOCK_TMUX_SEND_ALLOW: 'codex, %3' }],
    ])('%s sends at once and leaves the target unread', (_, env) => {
      const { exitCode, stdout, tmuxCalls } = send(['-t', '%3', 'make', 'Enter'], env);
      expect(exitCode).toBe(0);
      expect(askPayload(tmuxCalls)).toBeNull();
      const commands = runShellCommands(tmuxCalls);
      expect(commands).toContain("tmux -L tmuxy send-keys -t '%3' 'make' 'Enter'");
      expect(commands).toContain("tmux -L tmuxy set-option -p -t '%3' @tmuxy-pane-state unread");
      expect(stdout).toContain('sent to %3: make Enter');
    });

    test('a pane that says it is working keeps saying so', () => {
      const { tmuxCalls } = send(['-t', '%3', 'make'], {
        MOCK_TMUX_SEND_ASK: 'off',
        MOCK_TMUX_PANE_STATE: 'working',
      });
      expect(runShellCommands(tmuxCalls).some((cmd) => cmd.includes('@tmuxy-pane-state'))).toBe(
        false,
      );
    });

    test('an allow list naming someone else still asks', () => {
      const { tmuxCalls } = send(['-t', '%3', 'make'], {
        MOCK_TMUX_SEND_ALLOW: '%5',
        MOCK_TMUX_ANSWER: 'yes',
      });
      expect(askPayload(tmuxCalls)).not.toBeNull();
    });
  });

  describe('refusals', () => {
    test('needs keys to send', () => {
      const { exitCode, stderr } = send(['-t', '%3']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('keys required');
    });

    test('rejects a non-numeric timeout', () => {
      const { exitCode, stderr } = send(['-t', '%3', '--timeout', 'soon', 'ls']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('--timeout');
    });

    test('gives up when the question is never answered', () => {
      // No MOCK_TMUX_ANSWER: the option stays empty, as it does while the
      // question sits unanswered on screen.
      const { exitCode, stderr, tmuxCalls } = send(['-t', '%3', '--timeout', '1', 'ls']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('nothing sent');
      // The question must not outlive the sender.
      expect(
        runShellCommands(tmuxCalls).some((cmd) => /set-option -pu -t '%3' @tmuxy-ask$/.test(cmd)),
      ).toBe(true);
    });
  });

  test('--help explains itself without touching tmux', () => {
    const { stdout, exitCode, tmuxCalls } = send(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy pane send');
    expect(stdout).toContain('@tmuxy-send-allow');
    expect(tmuxCalls).toHaveLength(0);
  });

  test('ask is no longer a command', () => {
    const { exitCode } = runCLI(['ask', '%3', 'ls']);
    expect(exitCode).not.toBe(0);
  });
});
