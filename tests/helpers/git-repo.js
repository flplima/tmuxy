/**
 * Throwaway git repositories for tests that need one: in the temp dir, made
 * with none of the developer's git config, never one of the developer's own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** git in `dir`, reading no system or global config and running no hook. */
function git(dir, ...args) {
  return execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      encoding: 'utf-8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  ).trim();
}

/**
 * A repository named `name` with one commit, in a fresh directory of its
 * own under the temp dir; `remove` takes the directory and all in it away.
 */
function throwawayRepo(name = 'app') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-e2e-git-')));
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'first');
  return { root, repo, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

module.exports = { git, throwawayRepo };
