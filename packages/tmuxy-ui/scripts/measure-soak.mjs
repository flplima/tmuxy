#!/usr/bin/env node
/**
 * Soak harness — does a long session degrade?
 *
 * Nothing else in the suite runs for more than a few minutes, so the question
 * "what happens to a tab left open all day" has never had an answer. Every
 * other tier measures a single interaction against a budget; a leak does not
 * fail any of them, because each individual interaction stays fast while the
 * heap, the DOM and the server's memory climb underneath it.
 *
 * Two kinds of load, because they leak in different places:
 *
 *   * Output volume — tens of MB streamed through one pane. Exercises the
 *     control-mode parser, the delta protocol, the scrollback trim and the
 *     line components. A retained reference anywhere in that chain shows up as
 *     a heap or node count that does not come back down.
 *   * Structural churn — hundreds of split/kill cycles. Exercises pane
 *     creation and teardown on both sides: the app's machine state, the
 *     server's per-pane state, and tmux itself. A pane that is destroyed but
 *     not forgotten shows up here and nowhere else.
 *
 * ## What it asserts
 *
 * A plateau, not an absolute number. Absolute heap and RSS depend on the
 * machine, the Chrome build and what else the runner is doing, so a ceiling in
 * megabytes would be either meaningless or permanently red. Instead each
 * measure is sampled in windows across the run and the SECOND HALF is compared
 * to the first: a healthy session reaches a working set and stays there, so the
 * later windows must not be meaningfully above the earlier ones. A leak is
 * monotone growth, which is exactly what that comparison catches and what a
 * single before/after reading cannot distinguish from warm-up.
 *
 * Heap and node counts come from CDP `Performance.getMetrics` — the browser's
 * own accounting, not `performance.memory`, which is quantised to 5MB buckets
 * in a way that hides anything smaller than a catastrophe. Server RSS is read
 * from the OS for the pid serving the session.
 *
 * ## Load is driven through the CLI, not the keyboard
 *
 * The interaction harness next door types everything, because what it measures
 * IS the keystroke path. This one measures what the app retains while rendering
 * someone else's output, so it drives the load through `tmuxy pane send` — the
 * same path an agent uses — and leaves the browser as the thing being measured.
 *
 * That is not only a tidier seam, it is a necessary one: `keyboard.type()` of a
 * long command line into a pane drops characters often enough to be useless
 * here. Observed while building this, with a mangled `yes` command that lost
 * its middle and became an infinite loop printing the tail of the next word. A
 * memory measurement cannot be built on a load generator that sometimes runs a
 * different command than the one it was given.
 *
 * ## Why it is non-blocking at first
 *
 * `--gate` is off by default. The thresholds below are guesses until there is
 * a corpus of nightly runs to calibrate them against, and a guessed threshold
 * on a 10-minute job is a nightly that gets ignored. The job publishes the
 * report every night; once the numbers have a known shape, `--gate` goes on in
 * the workflow and the guesses become budgets.
 *
 * ## Run it against a socket of its own
 *
 * The churn phase splits and closes panes, and the output phase types into
 * whichever pane is active — in the session the server it is pointed at is
 * serving. A tmuxy server with no `TMUX_SOCKET` serves the DEFAULT `tmuxy`
 * socket, which on a dev machine is the session someone is working in, so
 * pointing this at one types megabytes of `yes` into their shell. The server
 * under test must be started with a socket of its own:
 *
 *   TMUX_SOCKET=tmuxy-soak ./target/release/tmuxy-server --port 9131 --dev
 *
 * (The three-socket rule in the repo's CLAUDE.md, for the same reason: a
 * released build serves `tmuxy`, the dev server `tmuxy-dev`, the E2E suite
 * `tmuxy-test`. This harness is a fourth caller and needs a fourth.)
 *
 * Usage:
 *   node measure-soak.mjs [--url URL] [--session NAME] [--cdp URL]
 *                         [--output-mb N] [--cycles N] [--windows N]
 *                         [--out FILE] [--label NAME] [--server-pid PID]
 *                         [--socket NAME] [--cli PATH] [--gate]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { waitForReady } from './lib/perf-harness.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(name);

const URL_BASE = opt('--url', 'http://localhost:9000');
const SESSION = opt('--session', null);
const CDP = opt('--cdp', null);
/** Megabytes of output to stream through a pane, total. */
const OUTPUT_MB = Number(opt('--output-mb', '20'));
/** split → kill cycles to run. */
const CYCLES = Number(opt('--cycles', '200'));
/** How many sample windows to divide each phase into. Must be even. */
const WINDOWS = Number(opt('--windows', '8'));
const OUT = opt('--out', null);
const LABEL = opt('--label', 'local');
const SERVER_PID = opt('--server-pid', null);
const GATE = flag('--gate');
/** The tmux socket the server under test is serving; see the header. */
const SOCKET = opt('--socket', process.env.TMUX_SOCKET ?? null);
const CLI = opt('--cli', new URL('../../../bin/tmuxy-cli', import.meta.url).pathname);

// Not named `URL`: that shadows the global this file uses to resolve the CLI
// path, and the shadow is hoisted, so the resolution hits a TDZ error.
const TARGET_URL = SESSION ? `${URL_BASE}?session=${encodeURIComponent(SESSION)}` : URL_BASE;

/**
 * How much the second half of a run may exceed the first before it is called
 * growth rather than noise. Generous on purpose: this has to separate "leaks a
 * node per pane" from "a GC happened to land late", and a false red on a
 * nightly is worse than a slow-burning true positive, which the trend in the
 * published reports will show anyway.
 */
const PLATEAU_TOLERANCE = {
  jsHeapMB: 0.35,
  domNodes: 0.25,
  jsEventListeners: 0.25,
  serverRssMB: 0.35,
};

/** Resident set size in MB for a pid, or null when it cannot be read. */
function rssMB(pid) {
  if (!pid) return null;
  try {
    const kb = Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf-8' }).trim(),
    );
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
  } catch {
    return null;
  }
}

/**
 * The CDP metrics worth watching, by the name `Performance.getMetrics` uses.
 *
 * `JSHeapUsedSize` rather than total: total is what Chrome has reserved from
 * the OS and moves in steps for reasons that have nothing to do with the page.
 */
const METRICS = {
  jsHeapMB: (m) => m.JSHeapUsedSize / (1024 * 1024),
  domNodes: (m) => m.Nodes,
  jsEventListeners: (m) => m.JSEventListeners,
};

/** One sample of every measure, taken at the current moment. */
async function sample(cdp, serverPid) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const byName = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  const row = { at: Date.now() };
  for (const [key, read] of Object.entries(METRICS)) row[key] = read(byName);
  row.serverRssMB = rssMB(serverPid);
  return row;
}

/**
 * Give the browser the best chance to have collected before a sample, so a
 * plateau is read as a plateau rather than as whatever the allocator happened
 * to be holding.
 *
 * Without this the comparison measures GC timing as much as retention: a
 * window that ends just before a collection reads high, the next reads low,
 * and the ratio between halves is noise. Chrome exposes no synchronous
 * "collect now" to a page, so this asks twice through CDP and then waits — a
 * best effort that is honest about being one.
 */
async function settle(cdp, page) {
  for (let i = 0; i < 2; i++) {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    await page.waitForTimeout(400);
  }
}

/**
 * Run a shell line in the session's active pane, through the tmuxy CLI.
 *
 * `pane send` routes the keys through `tmux run-shell`, which is the only
 * control-mode-safe way in (docs/TMUX.md). The line is handed over as one
 * argument so the shell quoting survives, and `Enter` is a separate key name
 * because that is how `send-keys` spells it.
 */
function runInPane(line) {
  execFileSync(CLI, ['pane', 'send', line, 'Enter'], {
    encoding: 'utf-8',
    env: { ...process.env, ...(SOCKET ? { TMUX_SOCKET: SOCKET } : {}) },
    timeout: 20000,
  });
}

/**
 * Stream `mb` megabytes through the active pane, sampling as it goes.
 *
 * `yes | head -c` is the cheapest generator that produces real bytes rather
 * than a tight redraw loop: the point is volume through the parser and the
 * delta protocol, not frame rate. It is split into chunks so samples land
 * between them rather than all at the end, which is what makes a plateau
 * visible at all.
 */
async function phaseOutput(page, cdp, serverPid, { mb, windows }) {
  const samples = [];
  const chunkMB = Math.max(1, Math.round(mb / windows));
  for (let w = 0; w < windows; w++) {
    // A sentinel echoed after the bytes, not a prompt match. With megabytes of
    // `yes` in the scrollback, "the text ends in a prompt character" is both
    // slow to evaluate and wrong as often as not — the last visible line is
    // whatever the trim left behind. A unique marker per window is exact, and
    // it is the same thing the SteadyStream story waits for.
    const done = `SOAK-OUTPUT-DONE-${w}`;
    // `head -c` on `yes` output: real bytes through the parser, the delta
    // protocol and the scrollback trim, rather than a tight redraw loop. The
    // sentinel is echoed after them and its own text never appears in the
    // stream, so finding it means the command finished rather than that the
    // marker happened to be mid-buffer.
    runInPane(`yes soakline | head -c ${chunkMB}m; echo ${done}`);
    await page.waitForFunction(
      (marker) =>
        [...document.querySelectorAll('[role="log"]')].some((l) =>
          (l.textContent || '').includes(marker),
        ),
      done,
      { timeout: 180000, polling: 500 },
    );
    await settle(cdp, page);
    samples.push({ window: w, ...(await sample(cdp, serverPid)) });
  }
  return samples;
}

/** How many distinct panes the page is showing. */
function countPanes(page) {
  return page.evaluate(
    () =>
      new Set(
        [...document.querySelectorAll('[data-pane-id]')].map((e) => e.getAttribute('data-pane-id')),
      ).size,
  );
}

/** Wait until the pane count satisfies `predicate`, or give up on this cycle. */
async function waitForPaneCount(page, predicate, reference) {
  await page
    .waitForFunction(
      ([ref, op]) => {
        const n = new Set(
          [...document.querySelectorAll('[data-pane-id]')].map((e) =>
            e.getAttribute('data-pane-id'),
          ),
        ).size;
        return op === 'gt' ? n > ref : n <= ref;
      },
      [reference, predicate],
      { timeout: 20000, polling: 100 },
    )
    // A cycle that does not complete is not the measurement failing — the next
    // one re-reads the count, so a missed split cannot desynchronise the loop.
    .catch(() => {});
}

/** Split the active pane, through the CLI's control-mode-safe route. */
function splitPane() {
  execFileSync(CLI, ['pane', 'split', '-v'], {
    encoding: 'utf-8',
    env: { ...process.env, ...(SOCKET ? { TMUX_SOCKET: SOCKET } : {}) },
    timeout: 20000,
  });
}

/**
 * Split and close a pane `cycles` times, sampling every window.
 *
 * Both halves go through the CLI — `pane split` to open and `exit` in the new
 * pane's own shell to close — for the reason in the header: this harness
 * measures what the app RETAINS, and the keystroke path is the interaction
 * harness's subject, not this one's. What matters for a per-pane leak is that
 * the pane really is created and destroyed in tmux and the app really learns
 * about both over SSE, which is identical either way. (A raw `tmux
 * split-window` would be worse than useless: an external mutation crashes the
 * server while control mode is attached — docs/TMUX.md. The CLI wraps it in
 * `run-shell`.)
 *
 * The browser is still watched throughout, because it is the thing being
 * measured: every cycle waits for the app's own pane count to move, so a
 * sample is never taken mid-transition.
 */
async function phaseChurn(page, cdp, serverPid, { cycles, windows }) {
  const samples = [];
  const perWindow = Math.max(1, Math.round(cycles / windows));

  for (let w = 0; w < windows; w++) {
    for (let i = 0; i < perWindow; i++) {
      const before = await countPanes(page);
      splitPane();
      await waitForPaneCount(page, 'gt', before);
      runInPane('exit');
      await waitForPaneCount(page, 'lte', before);
    }
    await settle(cdp, page);
    samples.push({ window: w, cyclesDone: (w + 1) * perWindow, ...(await sample(cdp, serverPid)) });
  }
  return samples;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Compare the second half of a phase's samples to the first.
 *
 * Returns one verdict per measure: the two halves' means, the growth between
 * them as a fraction, and whether that exceeds the measure's tolerance. A
 * measure with no readings at all (server RSS when the pid is unknown) reports
 * `null` rather than passing silently.
 */
function plateau(samples) {
  const half = Math.floor(samples.length / 2);
  const verdicts = {};
  for (const key of [...Object.keys(METRICS), 'serverRssMB']) {
    const early = samples
      .slice(0, half)
      .map((s) => s[key])
      .filter((v) => typeof v === 'number');
    const late = samples
      .slice(half)
      .map((s) => s[key])
      .filter((v) => typeof v === 'number');
    if (!early.length || !late.length) {
      verdicts[key] = { early: null, late: null, growth: null, withinTolerance: null };
      continue;
    }
    const e = mean(early);
    const l = mean(late);
    const growth = e > 0 ? (l - e) / e : 0;
    verdicts[key] = {
      early: Number(e.toFixed(2)),
      late: Number(l.toFixed(2)),
      growth: Number(growth.toFixed(4)),
      tolerance: PLATEAU_TOLERANCE[key],
      withinTolerance: growth <= PLATEAU_TOLERANCE[key],
    };
  }
  return verdicts;
}

/** The pid serving the session, from the dev-server pid file when present. */
function discoverServerPid() {
  if (SERVER_PID) return Number(SERVER_PID);
  // `bin/dev-server` writes `<pid>\t<start time>` to
  // `$STATE_DIR/<target>-server.pid`, where STATE_DIR follows the platform
  // (the same split as the trace file — see docs/TELEMETRY.md).
  const stateDirs = [
    process.env.TMUXY_STATE_DIR,
    `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/tmuxy`,
    `${process.env.HOME}/Library/Application Support/tmuxy`,
  ].filter(Boolean);
  const candidates = stateDirs.flatMap((dir) => [
    `${dir}/dev-server.pid`,
    `${dir}/prod-server.pid`,
  ]);
  for (const candidate of candidates) {
    try {
      const pid = Number(readFileSync(candidate, 'utf-8').split(/\s/)[0]);
      if (Number.isFinite(pid) && pid > 1) return pid;
    } catch {
      /* not this one */
    }
  }
  return null;
}

async function main() {
  if (WINDOWS % 2 !== 0 || WINDOWS < 4) {
    console.error(`--windows must be an even number of at least 4 (got ${WINDOWS})`);
    process.exit(2);
  }

  const serverPid = discoverServerPid();
  const browser = CDP
    ? await chromium.connectOverCDP(CDP)
    : await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
  const context = CDP
    ? (browser.contexts()[0] ?? (await browser.newContext()))
    : await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  if (CDP) await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');

  await waitForReady({
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    wait: (ms) => page.waitForTimeout(ms),
  });
  await page.locator('.pane-layout-item.pane-active [role="log"]').first().click({ timeout: 5000 });

  await settle(cdp, page);
  const baseline = await sample(cdp, serverPid);

  const started = Date.now();
  const output = await phaseOutput(page, cdp, serverPid, { mb: OUTPUT_MB, windows: WINDOWS });
  const churn = await phaseChurn(page, cdp, serverPid, { cycles: CYCLES, windows: WINDOWS });
  const durationMs = Date.now() - started;

  await settle(cdp, page);
  const final = await sample(cdp, serverPid);

  if (CDP) await page.close();
  else await browser.close();

  const report = {
    label: LABEL,
    platform: `${process.platform}-${process.arch}`,
    url: TARGET_URL,
    generatedAt: new Date().toISOString(),
    durationMs,
    load: { outputMB: OUTPUT_MB, cycles: CYCLES, windows: WINDOWS },
    serverPid,
    baseline,
    final,
    phases: {
      output: { samples: output, plateau: plateau(output) },
      churn: { samples: churn, plateau: plateau(churn) },
    },
  };

  const json = JSON.stringify(report, null, 2);
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${json}\n`);
    console.log(`wrote soak report → ${OUT}`);
  }

  // A table, because the shape of the numbers is the finding — a single
  // pass/fail hides whether something grew 2% or 200%.
  for (const [phaseName, phase] of Object.entries(report.phases)) {
    console.log(`\n${phaseName}:`);
    for (const [measure, v] of Object.entries(phase.plateau)) {
      if (v.growth === null) {
        console.log(`  ${measure.padEnd(18)} not measured`);
        continue;
      }
      const verdict = v.withinTolerance ? 'plateau' : 'GROWTH';
      console.log(
        `  ${measure.padEnd(18)} ${String(v.early).padStart(9)} → ${String(v.late).padStart(9)}` +
          `  ${(v.growth * 100).toFixed(1).padStart(7)}%  (tol ${(v.tolerance * 100).toFixed(0)}%)  ${verdict}`,
      );
    }
  }

  const grew = Object.entries(report.phases).flatMap(([phaseName, phase]) =>
    Object.entries(phase.plateau)
      .filter(([, v]) => v.withinTolerance === false)
      .map(([measure, v]) => `${phaseName}.${measure} +${(v.growth * 100).toFixed(1)}%`),
  );

  if (grew.length === 0) {
    console.log('\nEvery measure plateaued.');
    return;
  }

  const summary = `did not plateau: ${grew.join(', ')}`;
  if (GATE) {
    console.error(`\n${summary}`);
    process.exit(1);
  }
  // Not a gate yet: see the header. Still said out loud, so a trend is
  // visible in the job log without opening the artifact.
  console.warn(`\nwarning: ${summary} (not gating — pass --gate to fail on this)`);
}

main().catch((e) => {
  console.error('measure-soak failed:', e.stack || e.message);
  process.exit(1);
});
