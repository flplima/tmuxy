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
    for (const verb of ['reload', 'use-tmux-conf', 'init', 'paths']) {
      expect(stdout).toContain(verb);
    }
  });

  // The running app watches tmuxy.conf and a marker in the state dir, and
  // sources the chain on its own connection when either changes. The verb
  // touches the marker: it runs no tmux, and writes nothing into the config
  // dir, which may be a dotfiles checkout.
  test('config reload touches the state dir marker, not tmuxy.conf, and sends tmux nothing', () => {
    fs.mkdirSync(configDir, { recursive: true });
    const conf = path.join(configDir, 'tmuxy.conf');
    fs.writeFileSync(conf, '# conf\n');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(conf, past, past);

    const { stdout, exitCode, tmuxCalls } = runCLI(['config', 'reload'], { env });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Reloading');
    expect(tmuxCalls).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'config-reload'))).toBe(true);
    expect(Math.round(fs.statSync(conf).mtimeMs)).toBe(past.getTime());
    expect(fs.readFileSync(conf, 'utf8')).toBe('# conf\n');
  });

  test('config reload works with no tmuxy.conf at all', () => {
    const { exitCode } = runCLI(['config', 'reload'], { env });
    expect(exitCode).toBe(0);
    expect(fs.existsSync(configDir)).toBe(false);
  });

  test('config use-tmux-conf keeps the choice in the state dir', () => {
    expect(runCLI(['config', 'use-tmux-conf', 'on'], { env }).exitCode).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'tmuxy.state.json'), 'utf8'));
    expect(state).toEqual({ use_tmux_conf: true });
    expect(runCLI(['config', 'use-tmux-conf', '--json'], { env }).stdout.trim()).toBe(
      '{"ok":true,"useTmuxConf":true}',
    );
    expect(fs.existsSync(configDir)).toBe(false);
  });

  // The file holds every menu choice too: a write that leaves it invalid JSON
  // loses all of them, since the app reads an unparsable file as empty. With
  // no `sed` on PATH, so no GNU-only spelling (a `\n` in a replacement, which
  // BSD sed writes as a literal `n`) can be what makes the write work here.
  test.each([
    ['no file', null, { use_tmux_conf: true }],
    ['an empty object', '{}\n', { use_tmux_conf: true }],
    ['an empty object over lines', '{\n}\n', { use_tmux_conf: true }],
    [
      'an object without the key',
      '{\n  "theme": "nord",\n  "cursor_blink": false\n}\n',
      { theme: 'nord', cursor_blink: false, use_tmux_conf: true },
    ],
    [
      'an object with the key',
      '{\n  "theme": "nord",\n  "use_tmux_conf": false\n}\n',
      { theme: 'nord', use_tmux_conf: true },
    ],
    ['an object with the key compact', '{"use_tmux_conf":false}', { use_tmux_conf: true }],
  ])('config use-tmux-conf on keeps the state file valid JSON: %s', (_, before, after) => {
    const shims = path.join(root, 'shims');
    fs.mkdirSync(shims);
    fs.writeFileSync(path.join(shims, 'sed'), '#!/bin/sh\necho "sed was used" >&2\nexit 97\n', {
      mode: 0o755,
    });
    const file = path.join(stateDir, 'tmuxy.state.json');
    if (before !== null) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(file, before);
    }
    const shimmed = {
      ...env,
      PATH: `${shims}:${path.join(__dirname, 'mocks')}:${process.env.PATH}`,
    };

    const on = runCLI(['config', 'use-tmux-conf', 'on'], { env: shimmed });
    expect(on.stderr).toBe('');
    expect(on.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(after);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(runCLI(['config', 'use-tmux-conf', '--json'], { env: shimmed }).stdout.trim()).toBe(
      '{"ok":true,"useTmuxConf":true}',
    );

    expect(runCLI(['config', 'use-tmux-conf', 'off'], { env: shimmed }).exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...after, use_tmux_conf: false });
    expect(runCLI(['config', 'use-tmux-conf', '--json'], { env: shimmed }).stdout.trim()).toBe(
      '{"ok":true,"useTmuxConf":false}',
    );
  });

  test('config init writes the starter, which pins nothing, and never overwrites', () => {
    const { stdout, exitCode } = runCLI(['config', 'init', '--json'], { env });
    expect(exitCode).toBe(0);
    const conf = path.join(configDir, 'tmuxy.conf');
    expect(JSON.parse(stdout)).toEqual({ ok: true, file: conf });
    const starter = fs.readFileSync(conf, 'utf8');
    expect(starter).toContain('# tmuxy.conf: your overrides');
    // Comments only: no source-file line to keep, no option set.
    expect(starter.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))).toEqual([]);

    fs.writeFileSync(conf, 'set -g prefix C-Space\n');
    const again = runCLI(['config', 'init'], { env });
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('already exists');
    expect(fs.readFileSync(conf, 'utf8')).toBe('set -g prefix C-Space\n');
  });

  // A dotfiles checkout not cloned yet: the link is the user's, and writing
  // the starter through it would create a file in their repo.
  test('config init treats a dangling symlink as present', () => {
    fs.mkdirSync(configDir, { recursive: true });
    const target = path.join(root, 'dotfiles', 'tmuxy.conf');
    fs.symlinkSync(target, path.join(configDir, 'tmuxy.conf'));
    const { exitCode, stderr } = runCLI(['config', 'init'], { env });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('already exists');
    expect(fs.existsSync(target)).toBe(false);
  });

  test('config init copies the mirrored example, less its generated header', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'tmuxy.conf.example'),
      '# Generated by tmuxy\n# more header\n\n# starter body\nset -g @x 1\n',
    );
    expect(runCLI(['config', 'init'], { env }).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(configDir, 'tmuxy.conf'), 'utf8')).toBe(
      '# starter body\nset -g @x 1\n',
    );
  });

  test('config paths lists every file with its owner, location, and whether to edit or link it', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'tmuxy.conf'), '');
    const { stdout, exitCode } = runCLI(['config', 'paths', '--json'], { env });
    expect(exitCode).toBe(0);
    const { dirs, files } = JSON.parse(stdout);
    expect(dirs).toEqual({ config: configDir, data: dataDir, state: stateDir });

    const byName = Object.fromEntries(files.map((f) => [`${f.dir}/${f.name}`, f]));
    expect(byName['config/tmuxy.conf']).toMatchObject({
      path: path.join(configDir, 'tmuxy.conf'),
      owner: 'user',
      safeToEdit: true,
      safeToSymlink: true,
      exists: true,
    });
    expect(byName['data/tmuxy.defaults.conf']).toMatchObject({
      owner: 'tmuxy',
      safeToEdit: false,
      safeToSymlink: false,
      exists: false,
    });
    for (const name of [
      'config/custom.css',
      'config/themes/',
      'data/tmuxy.essentials.conf',
      'data/tmuxy.entry.conf',
      'data/themes/',
      'data/bin/',
      'data/README.md',
      'state/tmuxy.state.json',
      'state/servers.json',
      'state/trace.json',
      'state/launcher',
      'state/tmuxy.pid',
    ]) {
      expect(byName[name]).toBeDefined();
    }
    // Only the user's files are theirs to edit and to link.
    for (const f of files) {
      expect(f.safeToSymlink).toBe(f.owner === 'user');
    }

    const text = runCLI(['config', 'paths'], { env });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(`config  ${configDir}`);
    expect(text.stdout).toContain(path.join(stateDir, 'tmuxy.state.json'));
  });

  // The README in the data dir is the user's guide to the same files: every
  // one `config paths` lists is in its table.
  test('the config README lists every file config paths does', () => {
    const readme = fs.readFileSync(
      path.resolve(__dirname, '../../packages/tmuxy-core/assets/config-README.md'),
      'utf8',
    );
    const { files } = JSON.parse(runCLI(['config', 'paths', '--json'], { env }).stdout);
    for (const { name } of files) {
      const shown = name === 'themes/' ? '`themes/<' : `\`${name}\``;
      expect(readme).toContain(shown);
    }
  });
});
