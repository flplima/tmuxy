const { runCLI } = require('./helpers/run-cli');

/** The command names a help screen lists under its `Commands:` heading. */
function listedCommands(help) {
  const lines = help.split('\n');
  const start = lines.findIndex((line) => line === 'Commands:');
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.trim() === '');
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .map((line) => /^ {2}([a-z][a-z0-9-]*)\s/.exec(line)?.[1])
    .filter(Boolean);
}

/**
 * Every command the help reaches from `tmuxy --help` down: each noun it
 * lists, each subcommand that noun's help lists, and theirs. A subcommand a
 * dispatcher adds is probed once its noun's help lists it.
 */
function commandPaths(prefix = []) {
  if (prefix.length === 3) return [];
  const { stdout } = runCLI([...prefix, '--help']);
  return listedCommands(stdout).flatMap((name) => {
    const path = [...prefix, name];
    return [path, ...commandPaths(path)];
  });
}

const PATHS = commandPaths();
const NOUNS_WITH_COMMANDS = PATHS.filter(
  (path) => listedCommands(runCLI([...path, '--help']).stdout).length > 0,
);

describe('CLI help output', () => {
  test.each([[[]], [['--help']]])('tmuxy %j shows the top-level usage', (args) => {
    const { stdout, exitCode } = runCLI(args);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy <command>');
  });

  test('the walk reaches the nested commands', () => {
    expect(PATHS).toEqual(
      expect.arrayContaining([
        ['pane', 'list'],
        ['pane', 'group'],
        ['session', 'restore'],
        ['plugin', 'install'],
        ['gui'],
      ]),
    );
  });

  // A command's own help, or the server binary's verb asked for its help:
  // either way nothing runs, and tmux is never called.
  test.each(PATHS.map((path) => [path.join(' '), path]))(
    'tmuxy %s --help answers without running the command',
    (_name, path) => {
      const { stdout, exitCode, tmuxCalls } = runCLI([...path, '--help']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toEqual([]);
      expect(stdout).toMatch(/^Usage: |^mock-server-started .*--help\n$/);
    },
  );

  test.each(NOUNS_WITH_COMMANDS.map((path) => [path.join(' '), path]))(
    'tmuxy %s with no subcommand shows its help',
    (_name, path) => {
      const bare = runCLI(path);
      expect(bare.exitCode).toBe(0);
      expect(bare.stdout).toBe(runCLI([...path, '--help']).stdout);
    },
  );

  // `tmuxy run`'s help lists what the `run` verb runs, so it is the verb's.
  test('tmuxy run --help asks the run verb', () => {
    const { stdout, exitCode } = runCLI(['run', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('mock-server-started run -- --help');
  });
});
