const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');

describe('CLI config commands', () => {
  let root;
  let env;
  let configDir;
  let dataDir;
  let stateDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-cli-config-'));
    configDir = path.join(root, 'config', 'tmuxy');
    dataDir = path.join(root, 'data');
    stateDir = path.join(root, 'state');
    env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      TMUXY_DATA_DIR: dataDir,
      TMUXY_STATE_DIR: stateDir,
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('config --help lists every verb', () => {
    const { stdout, exitCode } = runCLI(['config', '--help']);
    expect(exitCode).toBe(0);
    for (const verb of ['reload', 'use-tmux-conf', 'init', 'paths', 'doctor']) {
      expect(stdout).toContain(verb);
    }
  });

  /**
   * Every setting is the server binary's `config` verb
   * (`packages/tmuxy-verbs/src/config_cli.rs`, and the files' writers in
   * tmuxy-core; `config init` against the real binary is in
   * `packages/tmuxy-server/tests/cli_verbs.rs`): the mock server prints what
   * it was handed.
   */
  test.each([
    [['config', 'reload'], 'config reload'],
    [['config', 'reload', '--json'], 'config reload --json'],
    [['config', 'use-tmux-conf'], 'config use-tmux-conf'],
    [['config', 'use-tmux-conf', 'true'], 'config use-tmux-conf on'],
    [['config', 'use-tmux-conf', '0', '--json'], 'config use-tmux-conf off --json'],
    [['config', 'paths', '--json'], 'config paths --json'],
    [['config', 'init'], 'config init'],
    [['config', 'init', '--json'], 'config init --json'],
    [['config', 'doctor'], 'config doctor'],
    [['config', 'doctor', '--fix', '--json'], 'config doctor --fix --json'],
  ])('%j is the config verb %p, and sends tmux nothing', (args, verb) => {
    const { stdout, exitCode, tmuxCalls } = runCLI(args, { env });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(`mock-server-started ${verb}`);
    expect(tmuxCalls).toEqual([]);
  });

  test('config doctor takes --fix, and nothing else', () => {
    const { stderr, exitCode, tmuxCalls } = runCLI(['config', 'doctor', '--all'], { env });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("invalid argument '--all'");
    expect(tmuxCalls).toEqual([]);
  });

  test('config use-tmux-conf takes on or off, and nothing else', () => {
    const { stderr, exitCode } = runCLI(['config', 'use-tmux-conf', 'maybe'], { env });
    expect(exitCode).toBe(2);
    expect(stderr).toContain('use-tmux-conf [on|off]');
  });
});
