/**
 * A fake `claude` for tests that start one by name (`agent revive`, `agent
 * fork`): first on the suite's own tmux server's PATH, so no real agent can
 * run, and recording the arguments it was given, so a test can prove it ran.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmuxyCli } = require('./cli');

/**
 * Put the fake on the test server's PATH until `restore()`.
 *
 * @param {{runAsOperator: (command: string) => string}} session - The test's tmux session
 * @returns {{scratch: string, args: () => string[] | null, restore: () => void}}
 */
function fakeClaudeOnPath(session) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-e2e-fake-claude-'));
  const marker = path.join(scratch, 'args');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/bash\nprintf '%s\\n' "$@" > '${marker}'\necho "fake claude resumed $2"\nexec -a claude sleep 600\n`,
  );
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const before = tmuxyCli(['run', 'show-environment', '-g', 'PATH'])
    .trim()
    .replace(/^PATH=/, '');
  if (!before.includes('/'))
    throw new Error(`the test server's PATH reads ${JSON.stringify(before)}`);
  session.runAsOperator(`set-environment -g PATH '${bin}:${before}'`);
  return {
    scratch,
    args: () =>
      fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8').trim().split('\n') : null,
    restore: () => {
      session.runAsOperator(`set-environment -g PATH '${before}'`);
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

module.exports = { fakeClaudeOnPath };
