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

/**
 * Whether the hook's background job let go of its lock: it runs to its end,
 * past the tmux write, and every later hook takes the lock at once.
 */
async function lockReleased(where) {
  const locks = () =>
    fs
      .readdirSync(where.dir)
      .filter((name) => name.startsWith('tmuxy-agent-'))
      .flatMap((base) =>
        fs
          .readdirSync(path.join(where.dir, base))
          .filter((pane) => fs.existsSync(path.join(where.dir, base, pane, '.lock'))),
      );
  const deadline = Date.now() + 10000;
  while (locks().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return locks().length === 0;
}

/** The commands the hook's job handed to `run-shell`, once `count` of them are there. */
async function writesAfterHook(logFile, count) {
  const writes = (calls) => calls.filter((c) => c[2] === 'run-shell').map((c) => c[5]);
  const deadline = Date.now() + 10000;
  let seen = writes(await callsAfterHook(logFile, 0));
  while (seen.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    seen = writes(await callsAfterHook(logFile, 0));
  }
  return seen;
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
    // macOS's bash 3.2 ran the job's tmux call in the job's own process, so
    // the job ended with it and never let go of its lock.
    expect(await lockReleased(where)).toBe(true);

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
    // Leaving needs-input takes what the pane was asked off it too (the
    // binary's `-`).
    expect(hook('claude', 'PostToolUse', 'working\n-', where).exitCode).toBe(0);
    expect((await writesAfterHook(where.log, 3)).slice(-2)).toEqual([
      expect.stringContaining("set-option -p -u -t '%5' @tmuxy-pane-status"),
      expect.stringContaining("@tmuxy-pane-state 'working'"),
    ]);

    // The session ending unsets it.
    expect(hook('claude', 'SessionEnd', 'clear', where).exitCode).toBe(0);
    expect((await writesAfterHook(where.log, 4)).slice(-1)[0]).toContain(
      "set-option -p -u -t '%5' @tmuxy-pane-state",
    );
  });

  // What the user is asked (`agent state`'s second line) goes on the pane
  // before the state, so a push sent on the state finds it there; another
  // question while the pane still waits replaces it.
  test('a question goes on the pane before the state that it needs the user', async () => {
    const where = scratch();
    const asked = 'state=blocked:kind=question:app=claude:msg=V2hpY2ggZnJhbWV3b3JrPw==';
    const said = `needs-input\n${asked}`;
    expect(hook('claude', 'PreToolUse', said, where).exitCode).toBe(0);
    expect(await writesAfterHook(where.log, 2)).toEqual([
      expect.stringContaining(`set-option -p -t '%5' @tmuxy-pane-status '${asked}'`),
      expect.stringContaining("set-option -p -t '%5' @tmuxy-pane-state 'needs-input'"),
    ]);

    const again = 'state=blocked:kind=permission:app=claude:msg=QWxsb3cgQmFzaDogbHM=';
    expect(hook('claude', 'PermissionRequest', `needs-input\n${again}`, where).exitCode).toBe(0);
    expect((await writesAfterHook(where.log, 3)).slice(2)).toEqual([
      expect.stringContaining(`@tmuxy-pane-status '${again}'`),
    ]);

    // Claude Code's later permission notification says nothing more: the
    // question stays. Its job is done once it has read the state.
    const reads = () =>
      callsAfterHook(where.log, 0).then(
        (calls) =>
          calls.filter((c) => c.includes('@tmuxy-pane-state') && c.includes('show-options')).length,
      );
    const before = await reads();
    expect(hook('claude', 'Notification', 'needs-input', where).exitCode).toBe(0);
    const deadline = Date.now() + 10000;
    while ((await reads()) === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await reads()).toBe(before + 1);
    expect(await writesAfterHook(where.log, 3)).toHaveLength(3);
  });

  // The agent inbox bridge, a spike (docs/AGENT-INBOX.md): off unless
  // switched on; records the socket's path only, never the session's token.
  test('with the inbox bridge on, a session records its process and inbox path, never its token', async () => {
    const socketPath = '/tmp/fake-inbox-dir/4242.sock';
    // A `ps` that names the process above the hook as Claude Code, as it is
    // when Claude Code runs the hook, and that, like the real one, names no
    // process that has ended. It answers slowly: a hook that asked it from
    // its background job would have returned by then.
    const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-agent-ps-'));
    fs.writeFileSync(
      path.join(stubs, 'ps'),
      [
        '#!/bin/sh',
        'sleep 0.5',
        'for pid; do :; done',
        'kill -0 "$pid" 2>/dev/null || exit 1',
        'case "$*" in',
        '  *lstart*) echo "Mon Jan  1 00:00:00 2026" ;;',
        '  *) echo "1 claude" ;;',
        'esac',
        '',
      ].join('\n'),
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
    expect(recorded[0]).toMatch(/@tmuxy-agent-inbox '[0-9]+\|[^|']+\|/);
    expect(recorded[0]).toContain(`|${socketPath}'`);
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
