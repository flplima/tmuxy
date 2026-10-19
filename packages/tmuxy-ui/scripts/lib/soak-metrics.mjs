import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * How much the second half of a run may exceed the first before it is called
 * growth rather than noise. Generous on purpose: this has to separate "leaks a
 * node per pane" from "a GC happened to land late", and a false red on a
 * nightly is worse than a slow-burning true positive, which the trend in the
 * published reports will show anyway.
 */
export const PLATEAU_TOLERANCE = {
  jsHeapMB: 0.35,
  domNodes: 0.25,
  jsEventListeners: 0.25,
  serverRssMB: 0.35,
};

/** Resident set size in MB for a pid, or null when it cannot be read. */
export function rssMB(pid) {
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
export const METRICS = {
  jsHeapMB: (m) => m.JSHeapUsedSize / (1024 * 1024),
  domNodes: (m) => m.Nodes,
  jsEventListeners: (m) => m.JSEventListeners,
};

/** One sample of every measure, taken at the current moment. */
export async function sample(cdp, serverPid) {
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
export async function settle(cdp, page) {
  for (let i = 0; i < 2; i++) {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    await page.waitForTimeout(400);
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Whether a measure is still climbing at the end of the run: the last two of
 * the second half's windows against its first two, at half the tolerance.
 * Warm-up — a pane filling with rows, a cache reaching its size — lifts the
 * second half over the first and then levels off inside it; a leak keeps
 * climbing to the last window. With too few windows to tell, it counts as
 * climbing, so the halves comparison alone decides.
 */
function stillRising(late, tolerance) {
  if (late.length < 4) return true;
  const start = mean(late.slice(0, 2));
  const end = mean(late.slice(-2));
  return start > 0 ? (end - start) / start > tolerance / 2 : end > start;
}

/**
 * Compare the second half of a phase's samples to the first.
 *
 * Returns one verdict per measure: the two halves' means, the growth between
 * them as a fraction, and whether the measure grew past its tolerance AND is
 * still climbing at the end (`stillRising`). A measure with no readings at
 * all (server RSS when the pid is unknown) reports `null` rather than passing
 * silently.
 */
export function plateau(samples) {
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
    const rising = stillRising(late, PLATEAU_TOLERANCE[key]);
    verdicts[key] = {
      early: Number(e.toFixed(2)),
      late: Number(l.toFixed(2)),
      growth: Number(growth.toFixed(4)),
      tolerance: PLATEAU_TOLERANCE[key],
      stillRising: rising,
      withinTolerance: growth <= PLATEAU_TOLERANCE[key] || !rising,
    };
  }
  return verdicts;
}

/** The pid serving the session, from the dev-server pid file when present. */
export function discoverServerPid(explicitPid) {
  if (explicitPid) return Number(explicitPid);
  // `bin/dev-server` writes `<pid>\t<start time>` to
  // `$STATE_DIR/<target>-server.pid`, where STATE_DIR follows the platform
  // (the same split as the trace file — see docs/TRACING.md).
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

/**
 * Print the phase plateau table and return the list of measures that grew past
 * tolerance.
 */
export function printSoakTable(phases) {
  // A table, because the shape of the numbers is the finding — a single
  // pass/fail hides whether something grew 2% or 200%.
  for (const [phaseName, phase] of Object.entries(phases)) {
    console.log(`\n${phaseName}:`);
    for (const [measure, v] of Object.entries(phase.plateau)) {
      if (v.growth === null) {
        console.log(`  ${measure.padEnd(18)} not measured`);
        continue;
      }
      let verdict = v.withinTolerance ? 'plateau' : 'GROWTH';
      if (v.withinTolerance && v.growth > v.tolerance) verdict = 'warm-up, then plateau';
      console.log(
        `  ${measure.padEnd(18)} ${String(v.early).padStart(9)} → ${String(v.late).padStart(9)}` +
          `  ${(v.growth * 100).toFixed(1).padStart(7)}%  (tol ${(v.tolerance * 100).toFixed(0)}%)  ${verdict}`,
      );
    }
  }

  return Object.entries(phases).flatMap(([phaseName, phase]) =>
    Object.entries(phase.plateau)
      .filter(([, v]) => v.withinTolerance === false)
      .map(([measure, v]) => `${phaseName}.${measure} +${(v.growth * 100).toFixed(1)}%`),
  );
}
