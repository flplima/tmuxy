const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');

describe('CLI config commands', () => {
  let configHome;

  beforeEach(() => {
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-cli-config-'));
  });

  afterEach(() => {
    fs.rmSync(configHome, { recursive: true, force: true });
  });

  test('config --help lists reload and use-tmux-conf', () => {
    const { stdout, exitCode } = runCLI(['config', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('reload');
    expect(stdout).toContain('use-tmux-conf');
  });

  // The running app watches tmuxy.conf and sources it on its own connection
  // when the file changes; the verb marks the file modified and runs no tmux.
  test('config reload marks tmuxy.conf modified and sends tmux nothing', () => {
    const dir = path.join(configHome, 'tmuxy');
    fs.mkdirSync(dir, { recursive: true });
    const conf = path.join(dir, 'tmuxy.conf');
    fs.writeFileSync(conf, '# conf\n');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(conf, past, past);

    const { stdout, exitCode, tmuxCalls } = runCLI(['config', 'reload'], {
      env: { XDG_CONFIG_HOME: configHome },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Reloading');
    expect(tmuxCalls).toEqual([]);
    expect(fs.statSync(conf).mtimeMs).toBeGreaterThan(past.getTime());
    expect(fs.readFileSync(conf, 'utf8')).toBe('# conf\n');
  });

  test('config reload fails when tmuxy.conf does not exist', () => {
    const { stderr, exitCode } = runCLI(['config', 'reload'], {
      env: { XDG_CONFIG_HOME: configHome },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('does not exist');
  });
});
