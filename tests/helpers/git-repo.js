/**
 * Throwaway git repositories for tests that need one, never one of the
 * developer's own, made with none of their git config: in the temp dir
 * (`throwawayRepo`), or in a folder the test gives (`gitRepo`, for what
 * reads a checkout: the `diff` widget). Shelling out lives here and not in
 * the test file because `*.test.js` may not use `child_process` (the
 * user-path rule, enforced by ESLint).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scrubbedEnv } = require('./tmux-socket');

/** The environment git runs in: none of the variables that would aim it elsewhere. */
function gitEnv() {
  const env = {
    ...scrubbedEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return env;
}

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
    { encoding: 'utf-8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** A new repository on `main` in `dir`, and git bound to it. */
function gitRepo(dir) {
  git(dir, 'init', '-q');
  return { git: (...args) => git(dir, ...args) };
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

module.exports = { git, gitRepo, throwawayRepo };
