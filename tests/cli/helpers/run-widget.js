/**
 * Run `tmuxy-widget` the way a pane runs it, then take its terminal away:
 * its output is read until the widget marker and then closed, and its input
 * ends after that, so the widget exits — and runs its exit trap — with a
 * stdout that no longer takes writes, as a widget whose pane (or session)
 * was killed does. tmux is the mock, logging every call.
 *
 * No shell in between: the widget is started directly, with SIGPIPE ignored
 * (through perl's `exec`, which keeps the disposition) so a write to the
 * closed stdout fails the way one to a dead terminal does, instead of
 * killing the widget before its trap runs.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIDGET = path.resolve(__dirname, '../../../packages/tmuxy-cli/bin/tmuxy/tmuxy-widget');
const MOCKS_DIR = path.resolve(__dirname, '../mocks');
const MARKER = '__TMUXY_WIDGET__';

/**
 * @param {string} pane - The widget's own pane (`TMUX_PANE`)
 * @returns {Promise<{ calls: string[], files: string[] }>} The mock's log
 *   lines once the widget has exited, and what was left in the directory it
 *   ran in.
 */
async function runWidgetWithPaneGone(pane) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-widget-gone-'));
  const log = path.join(dir, 'tmux.log');
  try {
    const child = spawn(
      'perl',
      ['-e', '$SIG{PIPE} = "IGNORE"; exec { "/bin/bash" } "bash", @ARGV', WIDGET, 'tree'],
      {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'ignore'],
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
    const exited = new Promise((resolve) => child.once('exit', resolve));
    // The terminal goes once the widget has drawn: output first, then input,
    // so the trap runs with nowhere to write.
    await new Promise((resolve) => {
      let seen = '';
      child.stdout.on('data', (chunk) => {
        seen += chunk.toString();
        if (seen.includes(MARKER)) {
          child.stdout.destroy();
          resolve();
        }
      });
      child.once('exit', resolve);
    });
    child.stdin.end();
    await exited;
    const calls = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
      : [];
    return { calls, files: fs.readdirSync(dir).sort() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runWidgetWithPaneGone };
