/**
 * A git repository of a test's own, in a folder it gives, for what reads a
 * checkout (the `diff` widget). Shelling out lives here and not in the test
 * file because `*.test.js` may not use `child_process` (the user-path rule,
 * enforced by ESLint). git runs with no global or system config of the
 * developer's and none of the variables that would aim it elsewhere.
 */

const { execFileSync } = require('child_process');
const { scrubbedEnv } = require('./tmux-socket');

function gitRepo(dir) {
  const env = { ...scrubbedEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  const git = (...args) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  git('init', '-q', '-b', 'main');
  return { git };
}

module.exports = { gitRepo };
