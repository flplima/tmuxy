const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy keymap` is the server binary's `keymap` verb
 * (`packages/tmuxy-verbs/src/keymap_cli.rs`; against a real tmux in
 * `packages/tmuxy-server/tests/keymap_verb.rs`): the script forwards what it
 * was given, `--json` included, and sends tmux nothing itself.
 */
describe('CLI keymap', () => {
  test.each([
    [['keymap'], 'keymap'],
    [['keymap', '--table', 'prefix', 't'], 'keymap --table prefix t'],
    [['keymap', '--json'], 'keymap --json'],
    [['--json', 'keymap', 'C-a'], 'keymap C-a --json'],
  ])('%j is the keymap verb %p', (args, verb) => {
    const { stdout, exitCode, tmuxCalls } = runCLI(args);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(`mock-server-started ${verb}`);
    expect(tmuxCalls).toEqual([]);
  });

  test('the top-level help lists it', () => {
    const { stdout } = runCLI(['--help']);
    expect(stdout).toMatch(/^ {2}keymap {6}Every key binding/m);
  });
});
