const { execSync, spawnSync } = require('child_process');

function startAliasServer(socket, configPath) {
  execSync(`tmux -L "${socket}" new-session -d -s test`, { stdio: 'ignore' });
  execSync(`tmux -L "${socket}" source-file "${configPath}"`, { stdio: 'ignore' });
}

function killAliasServer(socket) {
  try {
    execSync(`tmux -L "${socket}" kill-server`, { stdio: 'ignore' });
  } catch {
    // server already down
  }
}

function runRawTmux(socket, args) {
  return spawnSync('tmux', ['-L', socket, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, TMUX: '', TMUX_PANE: '' },
  });
}

module.exports = {
  startAliasServer,
  killAliasServer,
  runRawTmux,
};
