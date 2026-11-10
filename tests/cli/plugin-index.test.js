/**
 * `bin/ci/plugin-index.mjs`, the builder the plugin-index workflow runs, against
 * local repositories in place of the GitHub search: what it lists, what it
 * leaves out and says why, and names two repositories share.
 *
 * The checker is a stand-in for `tmuxy plugin check --json` (Rust, tested in
 * `tmuxy-server/tests/plugin_install.rs`): a manifest holding `INVALID` fails.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CHECKER, fixtureRepo, runPluginIndex } = require('./helpers/run-plugin-index');

const manifest = (name, extra = '') => `[plugin]\napi = 1\nname = "${name}"\n${extra}\n`;

describe('the plugin index builder', () => {
  let base;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-plugin-index-test-'));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  test('lists every valid manifest, leaves the rest out with why, and marks shared names', () => {
    const devtools = fixtureRepo(base, 'devtools', {
      'tmuxy-plugin.toml': manifest('chrome-devtools'),
    });
    const tools = fixtureRepo(base, 'tools', {
      'plugins/one/tmuxy-plugin.toml': manifest('one'),
      'plugins/two/tmuxy-plugin.toml': manifest('chrome-devtools'),
      // A valid manifest at a path `tmuxy plugin install` cannot name.
      'plugins/my plugin/tmuxy-plugin.toml': manifest('spaced'),
    });
    const broken = fixtureRepo(base, 'broken', {
      'tmuxy-plugin.toml': manifest('x', 'INVALID = 1'),
    });
    const empty = fixtureRepo(base, 'empty', { 'README.md': 'nothing here' });
    const entry = (fullName, r, stars) => ({
      full_name: fullName,
      default_branch: 'main',
      stargazers_count: stars,
      pushed_at: '2026-11-01T00:00:00Z',
      clone_url: r.url,
    });
    fs.writeFileSync(
      path.join(base, 'repos.json'),
      JSON.stringify([
        // Out of order, as a search may answer: the file comes out the same.
        entry('x/empty', empty, 0),
        entry('team/tmuxy-tools', tools, 3),
        entry('x/broken', broken, 0),
        entry('someone/tmuxy-chrome-devtools', devtools, 10),
      ]),
    );
    const checker = path.join(base, 'checker');
    fs.writeFileSync(checker, CHECKER, { mode: 0o755 });

    const out = path.join(base, 'plugins.json');
    const summary = path.join(base, 'summary.md');
    const run = runPluginIndex([
      '--tmuxy',
      checker,
      '--out',
      out,
      '--repos',
      path.join(base, 'repos.json'),
      '--summary',
      summary,
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('3 plugins indexed, 3 left out');

    const index = JSON.parse(fs.readFileSync(out, 'utf8'));
    const bySource = Object.fromEntries(index.plugins.map((p) => [p.source, p]));
    expect(Object.keys(bySource).sort()).toEqual([
      'someone/tmuxy-chrome-devtools',
      'team/tmuxy-tools/plugins/one',
      'team/tmuxy-tools/plugins/two',
    ]);
    expect(bySource['someone/tmuxy-chrome-devtools']).toMatchObject({
      name: 'chrome-devtools',
      sha: devtools.sha,
      stars: 10,
      description: 'about chrome-devtools',
      capabilities: ['actions'],
      duplicate: true,
    });
    expect(bySource['team/tmuxy-tools/plugins/two'].duplicate).toBe(true);
    expect(bySource['team/tmuxy-tools/plugins/one'].duplicate).toBeUndefined();
    expect(bySource['team/tmuxy-tools/plugins/one'].sha).toBe(tools.sha);
    // Most stars first.
    expect(index.plugins[0].source).toBe('someone/tmuxy-chrome-devtools');

    expect(index.excluded).toEqual([
      {
        source: 'team/tmuxy-tools/plugins/my plugin',
        reason: 'subdirectory "my plugin" is not a source path word',
      },
      { source: 'x/broken', reason: 'tmuxy-plugin.toml:2:1: unknown field' },
      { source: 'x/empty', reason: 'no tmuxy-plugin.toml' },
    ]);
    const md = fs.readFileSync(summary, 'utf8');
    expect(md).toContain('| x/broken | tmuxy-plugin.toml:2:1: unknown field |');
  });
});
