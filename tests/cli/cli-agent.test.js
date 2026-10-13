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
  for (;;) {
    const lines = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    if (lines.length >= count || Date.now() > deadline) {
      return lines.map((line) => JSON.parse(line).args);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

  test('a hook sets the pane state the event means, once per change', async () => {
    const where = scratch();
    expect(hook('claude', 'UserPromptSubmit', 'working', where).exitCode).toBe(0);
    let calls = await callsAfterHook(where.log, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe('run-shell');
    expect(calls[0][3]).toContain(
      "tmux -L tmuxy-test set-option -p -t '%5' @tmuxy-pane-state 'working'",
    );

    // The same state again costs no tmux call at all.
    expect(hook('claude', 'PostToolUse', 'working', where).exitCode).toBe(0);
    // The session ending unsets it.
    expect(hook('claude', 'SessionEnd', 'clear', where).exitCode).toBe(0);
    calls = await callsAfterHook(where.log, 2);
    expect(calls).toHaveLength(2);
    expect(calls[1][3]).toContain("set-option -p -u -t '%5' @tmuxy-pane-state");
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
    await new Promise((resolve) => setTimeout(resolve, 500));
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
});
