#!/usr/bin/env node
/**
 * Record the Storybook fixtures from real tmux.
 *
 * Each scenario under `src/stories/fixtures/scenarios/` is a list of steps
 * (`fixtures/scenario.ts`); this runs them against a fresh tmux server,
 * through the real tmuxy server, and writes the state after every step to
 * `src/stories/fixtures/gen/<scenario>.json`, which `FixtureAdapter` replays.
 * Scenarios are TypeScript, loaded through Vite, so they spell the app's own
 * commands with `toTmuxCommand`. Nothing in a story imitates tmux: what it
 * shows is what tmux answered.
 *
 * A scenario runs on a tmux socket and a port of its own, with a scratch HOME
 * and a plain bash (`$ ` prompt, no rc files), so a recording carries nothing
 * of the machine it was made on and two runs record the same screens.
 *
 * Usage, from packages/tmuxy-ui, after `cargo build --release -p tmuxy-server`:
 *
 *   node scripts/record-story-fixtures.mjs            # every scenario
 *   node scripts/record-story-fixtures.mjs tabs       # the ones named
 *
 * Re-run it when the wire state changes shape.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { runnerImport } from 'vite';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, '..');
const REPO = join(UI, '..', '..');
const FIXTURES = join(UI, 'src', 'stories', 'fixtures');
const SCENARIOS = join(FIXTURES, 'scenarios');
const OUT = join(FIXTURES, 'gen');
const SERVER_BIN =
  process.env.TMUXY_FIXTURE_SERVER ?? join(REPO, 'target', 'release', 'tmuxy-server');

/** The session every recording is of: what the stories call it. */
const SESSION = 'demo';
/** How long the state must stay unchanged to count as settled. */
const QUIET_MS = 400;
const STEP_TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A scratch HOME and the plain shell every pane runs. */
async function makeHome(root) {
  const home = join(root, 'home', SESSION);
  await mkdir(join(home, '.config', 'tmuxy'), { recursive: true });
  // Written before the server starts, so it keeps it: the shipped defaults
  // (the server sources them itself) and nothing of the user's.
  await writeFile(join(home, '.config', 'tmuxy', 'tmuxy.conf'), "# nothing of the user's\n");
  // The repo's CLI as `tmuxy`, for the widgets a pane runs (the tree column).
  const bin = join(root, 'bin');
  await mkdir(bin);
  await symlink(join(REPO, 'packages', 'tmuxy-cli', 'bin', 'tmuxy-cli'), join(bin, 'tmuxy'));
  // …and the tmux it drives, wherever this machine keeps it.
  const tmuxDir = dirname(execFileSync('sh', ['-c', 'command -v tmux']).toString().trim());
  // A pane's shell, or the command tmux hands it (`-c '<command>'`): a clean
  // environment but for what tmux sets to name the pane.
  const shell = join(root, 'fixture-shell');
  await writeFile(
    shell,
    [
      '#!/bin/sh',
      `cd "${home}"`,
      '[ $# -gt 0 ] || set -- -i',
      `exec env -i HOME="${home}" PATH="${bin}:${tmuxDir}:/usr/bin:/bin" TERM="\${TERM:-xterm-256color}" LANG=en_US.UTF-8 TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" BASH_SILENCE_DEPRECATION_WARNING=1 PS1='$ ' /bin/bash --norc --noprofile "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(shell, 0o755);
  return { home, shell };
}

/** One scenario's tmux and tmuxy servers, and the client the recorder plays. */
class Recording {
  constructor(name) {
    this.name = name;
    this.socket = `tmuxy-fixtures-${process.pid}-${name}`;
    this.keybindings = null;
    this.connectionId = 0;
  }

  async start() {
    this.root = await mkdtemp(join(tmpdir(), 'tmuxy-fixtures-'));
    const { home, shell } = await makeHome(this.root);
    this.home = home;
    // Both spellings of it: macOS's temp dir is a symlink into /private.
    this.homePaths = [await realpath(home), home];
    this.port = await freePort();
    this.server = spawn(SERVER_BIN, ['--port', String(this.port)], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        SHELL: shell,
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        TMUX_SOCKET: this.socket,
        TMUXY_STATE_DIR: join(this.root, 'state'),
        TMUXY_NO_SNAPSHOT: '1',
        TMUXY_NO_RESTORE: '1',
        TMUXY_NO_TRACE: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.serverLog = '';
    this.server.stderr.on('data', (d) => (this.serverLog += d));
    await this.waitForServer();
    this.openStream();
  }

  url(path) {
    return `http://127.0.0.1:${this.port}${path}?session=${SESSION}`;
  }

  async waitForServer() {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/`);
        if (res.ok || res.status === 404) return;
      } catch {
        // not listening yet
      }
      await sleep(100);
    }
    throw new Error(`${this.name}: the server did not come up\n${this.serverLog}`);
  }

  /** The event stream a client holds open: it is what brings the session up. */
  openStream() {
    this.abort = new AbortController();
    fetch(this.url('/events'), { signal: this.abort.signal })
      .then(async (res) => {
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            this.onEvent(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
        }
      })
      .catch(() => {});
  }

  onEvent(block) {
    if (process.env.FIXTURE_DEBUG) console.error('event:', block.slice(0, 200));
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (event !== 'connection-info' && event !== 'keybindings') return;
    // Every payload is `{ event, data }`.
    const payload = JSON.parse(data.join('\n')).data;
    if (event === 'connection-info') this.connectionId = payload.connection_id;
    else this.keybindings = payload;
  }

  async invoke(cmd, args = {}) {
    const res = await fetch(this.url('/commands'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Id': String(this.connectionId) },
      body: JSON.stringify({ cmd, args }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${this.name}: ${cmd} → ${JSON.stringify(body)}`);
    return body?.result;
  }

  /** The full state, once it has stopped changing (and `ready` holds of it). */
  async settledState(cols, rows, ready = () => true, what = 'the state to settle') {
    const until = Date.now() + STEP_TIMEOUT_MS;
    let last = null;
    let since = Date.now();
    while (Date.now() < until) {
      let state = null;
      try {
        state = await this.invoke('get_initial_state', { cols, rows });
      } catch {
        // the session is still coming up
      }
      const text = state && JSON.stringify(asRecorded(state));
      if (text !== last) {
        last = text;
        since = Date.now();
      } else if (state && Date.now() - since >= QUIET_MS && this.keybindings && ready(state)) {
        return asRecorded(state);
      }
      await sleep(100);
    }
    if (process.env.FIXTURE_DEBUG && last) console.error(screenText(JSON.parse(last)));
    throw new Error(`${this.name}: timed out waiting for ${what}\n${this.serverLog.slice(-2000)}`);
  }

  async stop() {
    this.abort?.abort();
    try {
      execFileSync('tmux', ['-L', this.socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    this.server?.kill('SIGTERM');
    await rm(this.root, { recursive: true, force: true });
  }
}

/** `@3` / `%12` as the number it is. */
const idNumber = (id) => Number(String(id).slice(1));

/**
 * A state as a replay keeps it: without the stream position it was taken at,
 * and with windows and panes in id order — the server lists them in its map's
 * order, which changes from run to run.
 */
function asRecorded(state) {
  const { seq: _seq, ...rest } = state;
  return {
    ...rest,
    windows: [...rest.windows].sort((a, b) => idNumber(a.id) - idNumber(b.id)),
    panes: [...rest.panes].sort((a, b) => idNumber(a.tmux_id) - idNumber(b.tmux_id)),
  };
}

/** Every line of every pane's screen, as text. */
export function screenText(state) {
  return state.panes
    .flatMap((pane) => pane.content ?? [])
    .map((line) => line.map((cell) => cell.c ?? '').join(''))
    .join('\n');
}

/** A line that is the shell's prompt, the trailing space trimmed off or not. */
const PROMPT = /^\$( |$)/;

/** Every shell is at its prompt; a pane running a widget draws none. */
const everyPanePrompted = (state) =>
  state.panes
    .filter((pane) => !pane.pane_widget)
    .every((pane) =>
      (pane.content ?? []).some((line) => PROMPT.test(line.map((c) => c.c ?? '').join(''))),
    );

async function record(name, scenario) {
  let cols = scenario.cols ?? 120;
  let rows = scenario.rows ?? 30;
  const rec = new Recording(name);
  const states = {};
  const previews = {};
  try {
    await rec.start();
    await rec.settledState(cols, rows, () => true, 'the session to come up');
    await rec.invoke('set_client_size', { cols, rows });
    for (const step of scenario.steps) {
      for (const [file, text] of Object.entries(step.files ?? {})) {
        await mkdir(dirname(join(rec.home, file)), { recursive: true });
        await writeFile(join(rec.home, file), text);
      }
      if (step.size) {
        ({ cols, rows } = step.size);
        await rec.invoke('set_client_size', { cols, rows });
      }
      for (const command of step.run ?? []) {
        await rec.invoke('run_tmux_command', { command });
        // One command at a time, as a client sends them.
        await sleep(step.pauseMs ?? 150);
      }
      const ready = (state) =>
        everyPanePrompted(state) && (!step.waitFor || screenText(state).includes(step.waitFor));
      states[step.state] = await rec.settledState(cols, rows, ready, `step ${step.state}`);
      for (const paneId of step.previews ?? []) {
        previews[paneId] = await rec.invoke('read_preview', { paneId });
      }
    }
  } finally {
    await rec.stop();
  }
  const fixture = {
    cols: scenario.cols ?? 120,
    rows: scenario.rows ?? 30,
    keybindings: rec.keybindings,
    states,
    ...(Object.keys(previews).length > 0 ? { previews } : {}),
  };
  // The scratch home shows through in the scripts the bindings run; the
  // recording names it as the machine it stands for would.
  let text = JSON.stringify(fixture);
  for (const path of rec.homePaths) text = text.split(path).join(`/home/${SESSION}`);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${name}.json`), `${text}\n`);
  console.log(`${name}: ${Object.keys(states).length} states`);
}

const wanted = process.argv.slice(2);
const files = (await readdir(SCENARIOS)).filter((f) => f.endsWith('.ts')).sort();
for (const file of files) {
  const name = file.replace(/\.ts$/, '');
  if (wanted.length > 0 && !wanted.includes(name)) continue;
  const { module } = await runnerImport(join(SCENARIOS, file), {
    root: UI,
    configFile: false,
    logLevel: 'error',
  });
  await record(name, module.default);
}
