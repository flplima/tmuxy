/**
 * Run `tmuxy pane listen` the way a plugin runs it, in the background, and
 * play the preview it listens to: the pane's widget tag lives in a file the
 * mock tmux reads on every question, and the widget's message log is the
 * file `tmuxy-widget-preview` writes, at the path both compute
 * (`preview_message_log` in packages/tmuxy-cli/bin/tmuxy/_lib).
 */

const fs = require('fs');
const path = require('path');
const { scriptEnv, withScratchDir } = require('./env');
const { startTree } = require('./process-tree');

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
 * @returns {{ lines: () => string[], waitForLines: (n: number) => Promise<string[]>, exited: Promise<{ code: number | null, stdout: string, stderr: string }>, running: () => boolean, stop: () => Promise<void> }}
 */
function startListener(home, args, env) {
  const { child, stop } = startTree(CLI_PATH, ['pane', 'listen', ...args], scriptEnv(home, env));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) =>
    child.once('close', (code) => resolve({ code, stdout, stderr })),
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
  return {
    lines,
    waitForLines,
    exited,
    running: () => child.exitCode === null,
    stop,
  };
}

/**
 * Run `fn` with a fresh scratch directory and a way to start listeners in it.
 * Every listener, and all it started, has exited before the directory goes,
 * whether `fn` saw it end or gave up on it.
 *
 * @param {(home: string, listen: (args: string[], env: Record<string, string>) => ReturnType<typeof startListener>) => Promise<void>} fn
 * @returns {Promise<void>}
 */
function withListeners(fn) {
  return withScratchDir('tmuxy-listen-', async (home) => {
    const started = [];
    const listen = (args, env) => {
      const listener = startListener(home, args, env);
      started.push(listener);
      return listener;
    };
    try {
      await fn(home, listen);
    } finally {
      await Promise.all(started.map((listener) => listener.stop()));
    }
  });
}

/**
 * An `ls` first on PATH that takes the preview's log away on cue, as it is
 * looked at: the moment between two looks of the listener's in which a
 * preview that ends removes its log.
 *
 * @param {string} home - The scratch directory
 * @param {string} log - The log to take away
 */
function vanishingLog(home, log) {
  const bin = path.join(home, 'vanish-bin');
  const cue = path.join(home, 'vanish-cue');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'ls'),
    [
      '#!/bin/bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = "$VANISH_LOG" ] && [ -e "$VANISH_CUE" ]; then rm -f "$VANISH_CUE" "$VANISH_LOG"; fi',
      'done',
      'PATH="${PATH#*:}" exec ls "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return {
    env: {
      PATH: `${bin}:${path.resolve(__dirname, '../mocks')}:${process.env.PATH}`,
      VANISH_LOG: log,
      VANISH_CUE: cue,
    },
    /** Take the log away the next time it is looked at. */
    arm: () => fs.writeFileSync(cue, ''),
    /** Whether it has been taken away. */
    done: () => !fs.existsSync(cue) && !fs.existsSync(log),
  };
}

module.exports = { fakePreview, vanishingLog, withListeners };
