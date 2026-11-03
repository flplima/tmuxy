/**
 * Running `bin/plugin-index.mjs` on local repositories, for
 * cli/plugin-index.test.js: the repositories made with git, the builder run
 * with node.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'bin/plugin-index.mjs');

const CHECKER = `#!/bin/bash
dir="$3"
if grep -q INVALID "$dir/tmuxy-plugin.toml"; then
  echo '{"ok":false,"error":"tmuxy-plugin.toml:2:1: unknown field","code":1}'
  exit 1
fi
name=$(sed -n 's/^name = "\\(.*\\)"/\\1/p' "$dir/tmuxy-plugin.toml")
printf '{"ok":true,"name":"%s","description":"about %s","platforms":["linux"],"capabilities":["actions"]}\\n' "$name" "$name"
`;

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } },
  ).trim();
}

/** A repository with `files`, committed; its clone URL and head. */
function fixtureRepo(base, name, files) {
  const dir = path.join(base, 'remote', name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'x');
  return { url: `file://${dir}`, sha: git(dir, 'rev-parse', 'HEAD') };
}

/** Run the builder with `args`; its exit status and output. */
function runPluginIndex(args) {
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

module.exports = { CHECKER, fixtureRepo, runPluginIndex };
