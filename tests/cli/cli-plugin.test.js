/**
 * `tmuxy plugin …` and the dispatch of a plugin's own `tmuxy <verb>`.
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

  /** The gate asks on the terminal, which a `run-shell` job has none of. */
  test('install, list and the rest run the binary directly, never through run-shell', () => {
    const install = runCLI(['plugin', 'install', 'someone/tmuxy-x', '--yes', '--sha', 'abc']);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain(
      'mock-server-started plugin install someone/tmuxy-x --yes --sha abc',
    );
    expect(install.tmuxCalls).toHaveLength(0);

    const list = runCLI(['plugin', 'list', '--json']);
    expect(list.stdout).toContain('mock-server-started plugin list --json');
  });

  test('action runs inside tmux, aimed at the caller’s pane', () => {
    const { exitCode, tmuxCalls } = runCLI(['plugin', 'action', 'devtools:open'], {
      env: IN_PANE_7,
    });
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(1);
    expect(tmuxCalls[0].args[0]).toBe('run-shell');
    expect(tmuxCalls[0].args[1]).toMatch(
      /tmuxy-server'? 'plugin' 'action' '--pane' '%7' 'devtools:open'$/,
    );
  });

  test('a pane the caller names is the one used', () => {
    const { tmuxCalls } = runCLI(['plugin', 'action', 'devtools:open', '--pane', '%3'], {
      env: IN_PANE_7,
    });
    expect(tmuxCalls[0].args[1]).toMatch(/'plugin' 'action' 'devtools:open' '--pane' '%3'$/);
    expect(tmuxCalls[0].args[1]).not.toContain('%7');
  });

  /** After `--` everything is the command's, `--pane` included. */
  test('arguments after -- reach the command untouched', () => {
    const { tmuxCalls } = runCLI(['plugin', 'action', 'devtools:open', '--', '--pane', "it's #1"], {
      env: IN_PANE_7,
    });
    expect(tmuxCalls[0].args[1]).toMatch(
      /'--pane' '%7' 'devtools:open' '--' '--pane' 'it'\\''s ##1'$/,
    );
  });
});

describe('a plugin verb', () => {
  test('an installed plugin’s verb runs through the binary with its arguments', () => {
    const { stdout, exitCode } = runCLI(['artifact', 'get', '--out', 'x'], {
      env: { MOCK_PLUGIN_VERBS: 'artifact' },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-server-started plugin cli artifact get --out x');
  });

  test('a word no plugin has is still an unknown command', () => {
    const { stderr, exitCode } = runCLI(['artifact'], { env: { MOCK_PLUGIN_VERBS: 'other' } });
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Unknown command: artifact');
  });

  /**
   * A plugin's verb may not be one of the CLI's nouns (`RESERVED_VERBS` in
   * tmuxy-core): the dispatcher would never reach it. The two lists are
   * written in two languages, so this keeps them together.
   */
  test('every noun the dispatcher has is reserved from plugins', () => {
    const root = path.resolve(__dirname, '../..');
    const cli = fs.readFileSync(path.join(root, 'packages/tmuxy-cli/bin/tmuxy-cli'), 'utf8');
    const rust = fs.readFileSync(path.join(root, 'packages/tmuxy-core/src/plugins.rs'), 'utf8');
    const main = cli.slice(cli.indexOf('# --- Main dispatcher ---'));
    // Flags (`--help|-h`) are no verbs: a verb starts with a letter.
    const arms = [...main.matchAll(/^ {2}([a-zA-Z|-]+)\)$/gm)]
      .flatMap((m) => m[1].split('|'))
      .filter((word) => /^[a-z]/.test(word));
    const start = rust.indexOf('pub const RESERVED_VERBS');
    const reserved = rust
      .slice(start, rust.indexOf('];', start))
      .match(/"([a-z-]+)"/g)
      .map((word) => word.slice(1, -1));
    expect(arms.length).toBeGreaterThan(10);
    for (const noun of arms) expect(reserved).toContain(noun);
  });
});
