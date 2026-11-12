const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { SOCKET, sealedEnv } = require('./helpers/env');
const { playedTmux } = require('./helpers/seal');

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
      TMUX: playedTmux(),
      TMUX_PANE: '%5',
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
        `tmux -L ${SOCKET} set-option -p -t '%5' @tmuxy-pane-state 'working'`,
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
          `tmux -L ${SOCKET} set-option -p -t '%5' @tmuxy-pane-state 'needs-input'`,
        ],
      }) + '\n',
    );
    expect(hook('claude', 'PostToolUse', 'working', where).exitCode).toBe(0);
    calls = await callsAfterHook(where.log, 6);
    expect(writes(calls).slice(-1)[0]).toContain("@tmuxy-pane-state 'working'");

    // The session ending unsets it. It also reads the inbox bridge's switch
    // (docs/AGENT-INBOX.md), one call more.
    expect(hook('claude', 'SessionEnd', 'clear', where).exitCode).toBe(0);
    calls = await callsAfterHook(where.log, 9);
    expect(writes(calls).slice(-1)[0]).toContain("set-option -p -u -t '%5' @tmuxy-pane-state");
  });

  // The agent inbox bridge, a spike (docs/AGENT-INBOX.md): off unless
  // switched on; records the socket's path only, never the session's token.
  test('with the inbox bridge on, a session records its process and inbox path, never its token', async () => {
    const socketPath = '/tmp/fake-inbox-dir/4242.sock';
    // A `ps` that names the process above the hook as Claude Code, as it is
    // when Claude Code runs the hook.
    const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-agent-ps-'));
    fs.writeFileSync(
      path.join(stubs, 'ps'),
      '#!/bin/sh\ncase "$*" in\n  *lstart*) echo "Mon Jan  1 00:00:00 2026" ;;\n  *) echo "1 claude" ;;\nesac\n',
      { mode: 0o755 },
    );
    const session = {
      CLAUDE_CODE_MESSAGING_SOCKET: socketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token-value',
      PATH: `${stubs}:${sealedEnv().PATH}`,
    };
    const inboxWrites = (calls) =>
      calls.filter((c) => c[2] === 'run-shell' && c[5].includes('@tmuxy-agent-inbox'));

    // Off: nothing recorded.
    const off = scratch();
    expect(hook('claude', 'SessionStart', 'idle', off, session).exitCode).toBe(0);
    let calls = await callsAfterHook(off.log, 3);
    expect(inboxWrites(calls)).toEqual([]);

    // On: the Claude process, its start and the path, and nothing of the
    // token anywhere tmux was told.
    const on = scratch();
    const switchOn = { ...session, MOCK_TMUX_SEND_INBOX: 'on' };
    expect(hook('claude', 'SessionStart', 'idle', on, switchOn).exitCode).toBe(0);
    calls = await callsAfterHook(on.log, 4);
    const recorded = inboxWrites(calls).map((c) => c[5]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(
      new RegExp(`@tmuxy-agent-inbox '[0-9]+\\|[^|']+\\|${socketPath.replace(/\./g, '\\.')}'`),
    );
    expect(JSON.stringify(calls)).not.toContain('secret-token-value');

    // No Claude Code process above the hook (a `ps` that names only
    // shells, and leaves a mark when asked): nothing to pin it to, nothing
    // recorded.
    const shells = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-agent-ps-'));
    const asked = path.join(shells, 'asked');
    fs.writeFileSync(path.join(shells, 'ps'), `#!/bin/sh\ntouch '${asked}'\necho "1 bash"\n`, {
      mode: 0o755,
    });
    const orphan = scratch();
    const noClaude = { ...switchOn, PATH: `${shells}:${sealedEnv().PATH}` };
    expect(hook('claude', 'SessionStart', 'idle', orphan, noClaude).exitCode).toBe(0);
    // Once the job has asked ps and heard of no Claude Code, it writes no more.
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(asked) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.existsSync(asked)).toBe(true);
    calls = await callsAfterHook(orphan.log, 3);
    expect(inboxWrites(calls)).toEqual([]);

    // A path that is not a plain absolute .sock path is not recorded.
    const odd = scratch();
    const oddPath = { ...switchOn, CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x'; kill-server; '.sock" };
    expect(hook('claude', 'SessionStart', 'idle', odd, oddPath).exitCode).toBe(0);
    calls = await callsAfterHook(odd.log, 3);
    expect(inboxWrites(calls)).toEqual([]);

    // The session ending takes it off.
    expect(hook('claude', 'SessionEnd', 'clear', on, switchOn).exitCode).toBe(0);
    calls = await callsAfterHook(on.log, 8);
    expect(
      inboxWrites(calls)
        .map((c) => c[5])
        .slice(-1)[0],
    ).toContain("set-option -p -u -t '%5' @tmuxy-agent-inbox");
  });

  test('outside a tmuxy pane a hook changes nothing, and still answers Antigravity', async () => {
    const where = scratch();
    // A plain tmux server's pane: not tmuxy's to draw.
    const { stdout, exitCode } = hook('agy', 'Stop', 'idle', where, {
      TMUX: playedTmux('plain-tmux'),
      TMUX_SOCKET: 'plain-tmux',
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
      `tmux -L ${SOCKET} set-option -p -u -t '%3' @tmuxy-pane-state`,
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
