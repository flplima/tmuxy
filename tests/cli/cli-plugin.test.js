/**
 * `tmuxy plugin …`, a plugin's own `tmuxy plugin <verb>` included.
 *
 * The CLI owns the routing: `action` creates panes, so it runs inside
 * `run-shell` with the caller's pane as its target; every other verb is the
 * binary's, run as a plain process so the install gate can ask on the
 * terminal. What the verbs do is Rust (`tmuxy_core::plugins`, and
 * `packages/tmuxy-server/tests/plugin_install.rs` end to end).
 */

const fs = require('fs');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');

const IN_PANE_7 = { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%7' };

describe('tmuxy plugin', () => {
  test('with no verb it prints its usage', () => {
    const { stdout, exitCode, tmuxCalls } = runCLI(['plugin']);
    expect(exitCode).toBe(0);
    for (const verb of ['install', 'list', 'update', 'remove', 'action', 'log', 'check', 'new']) {
      expect(stdout).toContain(verb);
    }
    expect(stdout).toContain('unsandboxed');
    expect(tmuxCalls).toHaveLength(0);
  });

  /**
   * The gate asks on the terminal, and `action --wait` waits in the caller's
   * own process, so every verb runs the binary directly; `action` puts the
   * one command list that opens a pane through run-shell itself.
   */
  test('every verb runs the binary directly, never through run-shell', () => {
    const install = runCLI(['plugin', 'install', 'someone/tmuxy-x', '--yes', '--sha', 'abc']);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain(
      'mock-server-started plugin install someone/tmuxy-x --yes --sha abc',
    );
    expect(install.tmuxCalls).toHaveLength(0);

    const action = runCLI(['plugin', 'action', 'devtools:open'], { env: IN_PANE_7 });
    expect(action.exitCode).toBe(0);
    expect(action.stdout).toContain('mock-server-started plugin action --pane %7 devtools:open');
    expect(action.tmuxCalls).toHaveLength(0);
  });

  /** clap reads `--json` as the binary's switch only before the command. */
  test('--json goes before the command', () => {
    expect(runCLI(['plugin', 'list', '--json']).stdout).toContain(
      'mock-server-started plugin --json list',
    );
    expect(runCLI(['--json', 'plugin', 'nobody-has-this']).stdout).toContain(
      'mock-server-started plugin --json nobody-has-this',
    );
  });

  test('a pane the caller names is the one used', () => {
    const { stdout } = runCLI(['plugin', 'action', 'devtools:open', '--pane', '%3'], {
      env: IN_PANE_7,
    });
    expect(stdout).toContain('mock-server-started plugin action devtools:open --pane %3');
    expect(stdout).not.toContain('%7');
  });

  /** After `--` everything is the command's: `--pane` and `--json` too. */
  test('arguments after -- reach the command untouched', () => {
    const { stdout } = runCLI(
      ['plugin', 'action', 'devtools:open', '--', '--pane', '--json', '-j'],
      { env: IN_PANE_7 },
    );
    expect(stdout).toContain(
      'mock-server-started plugin action --pane %7 devtools:open -- --pane --json -j',
    );
  });

  /** Without a tmux server there is still help, and a usage error is exit 2. */
  test('action needs no tmux server to answer --help', () => {
    const { exitCode, tmuxCalls } = runCLI(['plugin', 'action', '--help'], {
      env: { TMUX_SOCKET: 'nobody-listens-here' },
    });
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(0);
  });
});

describe('a plugin verb', () => {
  /** `tmuxy plugin <verb>`: the binary tells its own commands from a plugin's. */
  test('runs through the binary as `plugin <verb>`, with its arguments, outside tmux', () => {
    const { stdout, exitCode, tmuxCalls } = runCLI(['plugin', 'artifact', 'get', '--out', 'x']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-server-started plugin artifact get --out x');
    expect(tmuxCalls).toHaveLength(0);
  });

  /** A verb's arguments are its own, `-j` and `--json` included. */
  test('keeps the switches among its arguments', () => {
    const { stdout } = runCLI(['plugin', 'artifact', '-j', '4', '--json']);
    expect(stdout).toContain('mock-server-started plugin artifact -j 4 --json');
  });

  /** A plugin owns nothing at the top level: every top-level word is tmuxy's. */
  test('is not a top-level command', () => {
    const { stderr, stdout, exitCode } = runCLI(['artifact']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Unknown command: artifact');
    expect(stdout).not.toContain('mock-server-started');
  });

  /**
   * The dispatcher tells `plugin`'s own commands from a verb to know whose
   * arguments `--json` is among; RESERVED_VERBS in tmuxy-core is the same
   * list, which install refuses as a verb. Two languages, held together here.
   */
  test("the CLI and the binary agree on `tmuxy plugin`'s own commands", () => {
    const root = path.resolve(__dirname, '../..');
    const cli = fs.readFileSync(path.join(root, 'packages/tmuxy-cli/bin/tmuxy-cli'), 'utf8');
    const rust = fs.readFileSync(path.join(root, 'packages/tmuxy-core/src/plugins.rs'), 'utf8');
    const listed = cli
      .match(/^PLUGIN_COMMANDS="([^"]*)"/m)[1]
      .trim()
      .split(/\s+/)
      .filter((word) => !word.startsWith('-'));
    const start = rust.indexOf('pub const RESERVED_VERBS');
    const reserved = rust
      .slice(start, rust.indexOf('];', start))
      .match(/"([a-z-]+)"/g)
      .map((word) => word.slice(1, -1));
    expect(listed.sort()).toEqual(reserved.sort());
  });
});
