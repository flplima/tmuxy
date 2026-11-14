/**
 * Run `verified_own_pane` (packages/tmuxy-cli/bin/tmuxy/_contract) with the
 * process ancestry stubbed, as `/proc` (`_parent_of`) and `ps`
 * (`_process_table`) would give it, and tmux answering that pane `%3`'s
 * process is 4242, after the pane's own id, as `_pane_read` asks. `ME` is
 * the checking shell's pid.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const { sealedEnv } = require('./env');

const LIB = path.join(__dirname, '..', '..', '..', 'packages', 'tmuxy-cli', 'bin', 'tmuxy', '_lib');

/**
 * @param {object} stub
 * @param {string} [stub.parents] - `case` arms for `_parent_of` (`/proc`)
 * @param {string} [stub.table] - `pid ppid` lines for `_process_table` (`ps`)
 * @param {boolean} [stub.trust] - @tmuxy-trust-pane-claims on
 */
function ownPane({ parents = '', table = '', trust = false }) {
  const script = `
    source "$LIB"
    ME=$$
    _tmux() {
      case "$*" in
        *pane_pid*) printf '%s\\t%s\\n' %3 4242 ;;
        *trust-pane-claims*) ${trust ? 'echo on' : ':'} ;;
      esac
    }
    _parent_of() { case "$1" in ${parents} *) ;; esac; }
    _process_table() { printf '%b' "${table}"; }
    verified_own_pane %3
  `;
  const run = spawnSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: sealedEnv({ LIB }),
  });
  return { claim: run.stdout, said: run.stderr };
}

module.exports = { ownPane };
