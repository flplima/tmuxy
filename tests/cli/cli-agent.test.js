const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy agent hook` sets the pane state in a background job (so the agent
 * never waits on tmux), so its tmux calls land after the CLI has returned:
 * read the mock's log until the expected number of calls is there.
 */
async function callsAfterHook(logFile, count) {
  const deadline = Date.now() + 10000;
  const read = () =>
    fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];
  let lines = read();
  while (lines.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    lines = read();
  }
  return lines.map((line) => JSON.parse(line).args);
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-agent-test-'));
  return { dir, log: path.join(dir, 'tmux.log') };
}

/** A hook as an agent runs it, inside pane %5 of a tmuxy server. */
function hook(agent, event, state, where, extraEnv = {}) {
  return runCLI(['agent', 'hook', agent, event], {
    input: '{}',
    env: {
      TMUX: '/tmp/tmux-501/tmuxy-test,4242,0',
      TMUX_PANE: '%5',
      TMUX_SOCKET: 'tmuxy-test',
      TMPDIR: where.dir,
      MOCK_TMUX_LOG: where.log,
      MOCK_AGENT_STATE: state,
      ...extraEnv,
    },
  });
}

describe('tmuxy agent', () => {
  test('install, uninstall and status are the server binary’s', () => {
    const { stdout, exitCode } = runCLI(['agent', 'install', 'claude', '--dry-run']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('mock-server-started agent install claude --dry-run');
  });

  // The state is read from tmux before it is written, never remembered: the
  // screen corrector, a send's question and `tmuxy pane state` write it too,
  // and a remembered "already applied" skipped the hook that had to put it
  // back — a pane left needs-input after the user answered.
  test('a hook sets the pane state the event means, whenever tmux says otherwise', async () => {
    const where = scratch();
    const writes = (calls) => calls.filter((c) => c[2] === 'run-shell').map((c) => c[5]);
    expect(hook('claude', 'UserPromptSubmit', 'working', where).exitCode).toBe(0);
    let calls = await callsAfterHook(where.log, 2);
    expect(calls[1].slice(2, 5)).toEqual(['run-shell', '-t', '%5']);
    expect(writes(calls)).toEqual([
      expect.stringContaining(
        "tmux -L tmuxy-test set-option -p -t '%5' @tmuxy-pane-state 'working'",
      ),
    ]);

    // The same state again: tmux already says it, so nothing is written.
    expect(hook('claude', 'PostToolUse', 'working', where).exitCode).toBe(0);
    calls = await callsAfterHook(where.log, 3);
    expect(writes(calls)).toHaveLength(1);

    // Something else marked the pane meanwhile; the same event's state is
    // written again.
    fs.appendFileSync(
      where.log,
      JSON.stringify({
        args: [
          'run-shell',
          "tmux -L tmuxy-test set-option -p -t '%5' @tmuxy-pane-state 'needs-input'",
        ],
      }) + '\n',
    );
    expect(hook('claude', 'PostToolUse', 'working', where).exitCode).toBe(0);
    calls = await callsAfterHook(where.log, 6);
    expect(writes(calls).slice(-1)[0]).toContain("@tmuxy-pane-state 'working'");

    // The session ending unsets it.
    expect(hook('claude', 'SessionEnd', 'clear', where).exitCode).toBe(0);
    calls = await callsAfterHook(where.log, 8);
    expect(writes(calls).slice(-1)[0]).toContain("set-option -p -u -t '%5' @tmuxy-pane-state");
  });

  test('outside a tmuxy pane a hook changes nothing, and still answers Antigravity', async () => {
    const where = scratch();
    // A plain tmux server's pane: not tmuxy's to draw.
    const { stdout, exitCode } = hook('agy', 'Stop', 'idle', where, {
      TMUX: '/tmp/tmux-501/default,4242,0',
      TMUX_SOCKET: 'default',
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('{}');
    // No pane at all: an agent in a terminal outside tmux.
    expect(hook('claude', 'Stop', 'idle', where, { TMUX: '', TMUX_PANE: '' }).exitCode).toBe(0);
    // Nothing was handed to the background job that sets the state: it would
    // have recorded the state it wanted first, under TMPDIR, and there is none.
    expect(fs.readdirSync(where.dir).filter((f) => f.startsWith('tmuxy-agent-'))).toEqual([]);
    expect(fs.existsSync(where.log)).toBe(false);
  });

  test('pane state clear unsets the option', () => {
    const { exitCode, tmuxCalls } = runCLI(['pane', 'state', 'clear', '%3']);
    expect(exitCode).toBe(0);
    expect(tmuxCalls[0].args).toEqual([
      'run-shell',
      "tmux -L tmuxy set-option -p -u -t '%3' @tmuxy-pane-state",
    ]);
  });

  // Core reads the exact word: `needs_input` written to tmux would show no
  // question, send no push and never be cleared by the screen corrector.
  test.each(['needs_input', 'Needs-Input', 'working|idle', 'busy'])(
    'pane state %j is a bad command line and writes nothing',
    (word) => {
      const { exitCode, stderr, tmuxCalls } = runCLI(['pane', 'state', word, '%3']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain(`unknown pane state '${word}'`);
      expect(tmuxCalls).toEqual([]);
    },
  );
});
