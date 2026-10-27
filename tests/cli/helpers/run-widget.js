/**
 * Run `tmuxy-widget` the way a pane runs it, then take its terminal away:
 * the reader of its output leaves once the widget marker is out, and its
 * input ends a second later, so the widget exits — and runs its exit trap —
 * with a stdout that no longer takes writes, as a widget whose pane (or
 * session) was killed does. tmux is the mock, logging every call.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIDGET = path.resolve(__dirname, '../../../packages/tmuxy-cli/bin/tmuxy/tmuxy-widget');
const MOCKS_DIR = path.resolve(__dirname, '../mocks');

/**
 * @param {string} pane - The widget's own pane (`TMUX_PANE`)
 * @returns {{ calls: string[], files: string[] }} The mock's log lines once
 *   the trap has unset the widget's pane option, and what was left in the
 *   directory the widget ran in.
 */
function runWidgetWithPaneGone(pane) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-widget-gone-'));
  const log = path.join(dir, 'tmux.log');
  try {
    spawnSync(
      'bash',
      [
        '-c',
        `(sleep 1) | perl -e '$SIG{PIPE}="IGNORE"; exec "/bin/bash", @ARGV' "$0" tree | sed -n '/__TMUXY_WIDGET__/q'`,
        WIDGET,
      ],
      {
        cwd: dir,
        timeout: 15000,
        env: {
          ...process.env,
          PATH: `${MOCKS_DIR}:${process.env.PATH}`,
          MOCK_TMUX_LOG: log,
          TMUX_SOCKET: 'tmuxy',
          TMUX_PANE: pane,
          TMUX: '',
        },
      },
    );
    // The trap outlives the pipeline: its reader left first.
    const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : []);
    const deadline = Date.now() + 10000;
    while (!read().some((line) => line.includes('set-option -p -u')) && Date.now() < deadline) {
      spawnSync('sleep', ['0.1']);
    }
    return { calls: read().filter(Boolean), files: fs.readdirSync(dir).sort() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runWidgetWithPaneGone };
