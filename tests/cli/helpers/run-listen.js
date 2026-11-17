/**
 * Run `tmuxy pane listen` the way a plugin runs it, in the background, and
 * play the preview it listens to: the pane's widget tag lives in a file the
 * mock tmux reads on every question, and the widget's message log is the
 * file `tmuxy-widget-preview` writes, at the path both compute
 * (`preview_message_log` in packages/tmuxy-cli/bin/tmuxy/_lib).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scriptEnv } = require('./env');

const CLI_PATH = path.resolve(__dirname, '../../../packages/tmuxy-cli/bin/tmuxy-cli');

/** The socket path the mock tmux answers with. */
const SOCKET_PATH = '/tmp/tmux-1000/tmuxy%dev';

/**
 * The preview in pane `pane`, as the listener sees it.
 *
 * @param {string} home - The scratch directory the CLI takes as `HOME`
 * @param {string} pane - The pane id (`%5`)
 */
function fakePreview(home, pane) {
  const stateDir = path.join(home, 'state');
  const tagFile = path.join(home, 'widget-tag');
  const tmuxLog = path.join(home, 'tmux.log');
  const key = SOCKET_PATH.replace(/%/g, '%25').replace(/\//g, '%2F');
  const log = path.join(stateDir, 'preview-messages', `${key}.${pane.slice(1)}.log`);
  fs.writeFileSync(tagFile, '');
  return {
    log,
    env: {
      TMUXY_STATE_DIR: stateDir,
      MOCK_TMUX_PANE_WIDGET_FILE: tagFile,
      MOCK_TMUX_SOCKET_PATH: SOCKET_PATH,
      MOCK_TMUX_LOG: tmuxLog,
    },
    /** How many times a listener has asked tmux for the pane's widget tag. */
    asked(file = tmuxLog) {
      if (!fs.existsSync(file)) return 0;
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.includes('@tmuxy-pane-widget')).length;
    },
    /** The widget starts: its log first, then its tag. */
    start(lines = []) {
      fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
      fs.writeFileSync(log, lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
      fs.writeFileSync(tagFile, 'preview');
    },
    /** A line the widget read, appended as it appends one. */
    receive(line) {
      fs.appendFileSync(log, `${line}\n`);
    },
    /** The log past its cap: a new file in its place. */
    startOver() {
      fs.writeFileSync(`${log}.new`, '', { mode: 0o600 });
      fs.renameSync(`${log}.new`, log);
    },
    /** The widget ends: its tag goes. */
    end() {
      fs.writeFileSync(tagFile, '');
    },
  };
}

/**
 * Start `tmuxy pane listen <args>` in the background.
 *
 * @param {string} home - The scratch directory the CLI takes as `HOME`
 * @param {string[]} args - What follows `pane listen`
 * @param {Record<string, string>} env - The preview's environment, and more
 * @returns {{ lines: () => string[], waitForLines: (n: number) => Promise<string[]>, exited: Promise<{ code: number | null, stdout: string, stderr: string }> }}
 */
function startListener(home, args, env) {
  const child = spawn(CLI_PATH, ['pane', 'listen', ...args], {
    env: scriptEnv(home, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) =>
    child.once('exit', (code) => resolve({ code, stdout, stderr })),
  );
  const lines = () => stdout.split('\n').filter(Boolean);
  const waitForLines = async (n) => {
    const until = Date.now() + 10000;
    while (lines().length < n) {
      if (child.exitCode !== null || Date.now() > until) {
        throw new Error(`expected ${n} lines, got ${JSON.stringify(lines())}; stderr: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return lines();
  };
  return { lines, waitForLines, exited, kill: () => child.kill() };
}

module.exports = { fakePreview, startListener };
