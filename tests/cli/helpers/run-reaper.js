/**
 * Drive `bin/tmuxy/reap-orphan-shells` with a stubbed `ps`.
 *
 * The reaper's whole risk is *which* processes it selects — it sends SIGKILL,
 * so a shell someone is using must never match. Running it against the real
 * process table would assert nothing repeatable, so the stub supplies the
 * process table and the run stays in `--dry-run`: the selection is observable
 * and no signal is sent to anything.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAPER = path.join(__dirname, '..', '..', '..', 'bin', 'tmuxy', 'reap-orphan-shells');

/**
 * @param {string} psOutput  Lines of `pid ppid time comm`, as `ps` would print them.
 * @param {string[]} args    Reaper arguments; defaults to a dry run.
 * @returns {string}         Trimmed stdout.
 */
function runReaper(psOutput, args = ['--dry-run']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-reap-'));
  try {
    // The stub ignores its arguments, which is what keeps the fixtures
    // readable: the script asks for `pid= ppid= time= comm=` and a fixture is
    // exactly those four columns.
    const stub = path.join(dir, 'ps');
    fs.writeFileSync(stub, `#!/bin/sh\ncat <<'PSEOF'\n${psOutput}\nPSEOF\n`, { mode: 0o755 });
    return execFileSync('bash', [REAPER, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runReaper };
