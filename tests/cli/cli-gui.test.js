const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy gui` opens the desktop app, which is the only binary with a `gui`
 * verb: the web server (`tmuxy-server`, the mock on PATH here) has none.
 */
describe('tmuxy gui', () => {
  let dir;
  let desktop;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-gui-'));
    desktop = path.join(dir, 'tmuxy');
    fs.writeFileSync(desktop, '#!/bin/bash\necho "desktop $*"\n', { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('runs the desktop app serving this socket', () => {
    const { stdout, exitCode } = runCLI(['gui', '--x'], {
      env: {
        TMUXY_SERVER_BIN: desktop,
        TMUXY_SERVER_SUBCOMMAND: 'server',
        TMUXY_STATE_DIR: dir,
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('desktop gui --x');
  });

  test('runs the installed app the launcher file names, not the web server', () => {
    fs.writeFileSync(path.join(dir, 'launcher'), desktop);
    const { stdout, exitCode } = runCLI(['gui'], { env: { TMUXY_STATE_DIR: dir } });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('desktop gui');
  });

  test('with no desktop app, says so and exits 1', () => {
    const { stdout, stderr, exitCode } = runCLI(['gui'], { env: { TMUXY_STATE_DIR: dir } });
    expect(exitCode).toBe(1);
    expect(stdout).not.toContain('mock-server-started');
    expect(stderr).toContain('the desktop app is not installed');
  });
});
