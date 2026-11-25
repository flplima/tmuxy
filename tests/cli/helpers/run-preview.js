/**
 * Run `tmuxy open <file>` the way a pane runs it, and watch what it does
 * with the file: every revision line it prints, and every time it reads the
 * file (it reads through `cksum`, played here by a shim that counts the
 * call and then runs the real one). tmux is the mock.
 */

const fs = require('fs');
const path = require('path');
const { MOCKS_DIR, scriptEnv } = require('./env');
const { startTree } = require('./process-tree');

const CLI_PATH = path.resolve(__dirname, '../../../packages/tmuxy-cli/bin/tmuxy-cli');
const REV = '__REV__:';
/** How long a wait lasts before it fails. */
const WAIT_MS = 15000;

/** The first `name` on the test's own PATH, by its full path: what a shim of that name runs. */
function theReal(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // not in this directory
    }
  }
  throw new Error(`no ${name} on PATH`);
}

/**
 * @param {string} home - The scratch directory the CLI takes as `HOME`
 * @param {string} file - The document to preview
 * @param {string} pane - The preview's own pane (`TMUX_PANE`)
 * @returns {{ reads: () => number, waitForRevisions: (count: number) => Promise<string[]>, waitUntilNotRead: (ms: number) => Promise<void>, stop: () => Promise<void> }}
 */
function startPreview(home, file, pane) {
  const shims = path.join(home, `shims-${pane.slice(1)}`);
  const reads = path.join(home, `reads-${pane.slice(1)}`);
  fs.mkdirSync(shims);
  fs.writeFileSync(
    path.join(shims, 'cksum'),
    `#!/bin/bash\necho >>"$PREVIEW_READS"\nexec '${theReal('cksum')}' "$@"\n`,
    { mode: 0o755 },
  );
  // In a terminal of its own, as in a pane: the preview reads the terminal
  // between two looks at the file. Python's `pty` gives it one the same way
  // on Linux and macOS, whatever this process has for a stdin (`script`
  // would, but the BSD one refuses a stdin that is a socket).
  const inTerminal = ['-c', 'import pty, sys; pty.spawn(sys.argv[1:])', CLI_PATH, 'open', file];
  const { child, stop } = startTree(
    'python3',
    inTerminal,
    scriptEnv(home, {
      PATH: `${shims}:${MOCKS_DIR}:${process.env.PATH}`,
      PREVIEW_READS: reads,
      TMUXY_STATE_DIR: path.join(home, 'state'),
      MOCK_TMUX_PANE_PID: String(process.pid),
      MOCK_TMUX_SOCKET_PATH: '/tmp/tmux-1000/tmuxy%dev',
      TMUX_PANE: pane,
      // What the widget hands the pane to on its way out.
      SHELL: theReal('true'),
    }),
  );
  let printed = '';
  let complained = '';
  child.stdout.on('data', (chunk) => {
    printed += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    complained += chunk.toString();
  });
  /** What the preview wrote, for a wait that gave up. */
  const said = () =>
    `it printed ${JSON.stringify(printed.slice(-400))}, and on stderr ${JSON.stringify(complained.slice(-400))}`;
  const revisions = () =>
    printed
      .split(/\r?\n/)
      .filter((line) => line.startsWith(REV))
      .map((line) => line.slice(REV.length));
  const readCount = () => (fs.existsSync(reads) ? fs.readFileSync(reads, 'utf8').length : 0);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    /** How many times the file has been read. */
    reads: readCount,
    /** Resolves with the revisions once `count` were printed, one per change the preview saw. */
    async waitForRevisions(count) {
      const deadline = Date.now() + WAIT_MS;
      while (revisions().length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `the preview printed ${revisions().length} revisions, not ${count}: ${said()}`,
          );
        }
        await pause(50);
      }
      return revisions();
    },
    /** Resolves once the file has not been read for `ms`: the preview found it still. */
    async waitUntilNotRead(ms) {
      const deadline = Date.now() + WAIT_MS;
      let seen = readCount();
      let since = Date.now();
      while (Date.now() - since < ms) {
        if (Date.now() > deadline) {
          throw new Error(`the file is still being read, ${seen} times so far: ${said()}`);
        }
        await pause(50);
        if (readCount() !== seen) {
          seen = readCount();
          since = Date.now();
        }
      }
    },
    /**
     * Take the preview's terminal away, and resolve once it and everything it
     * started has exited. The CLI runs in a session of its own on that
     * terminal, and ends on the hang-up, clean-up and all.
     */
    stop,
  };
}

module.exports = { startPreview };
