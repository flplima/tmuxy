#!/usr/bin/env node
/**
 * Interaction-latency gate and trend report over a `measure-interactions.mjs`
 * report, judged three ways because its signals have very different noise
 * floors:
 *
 *  1. **Ratio budgets — the gate.** Each interaction's cost as a multiple of
 *     the keystroke echo measured in the same run. A slow runner inflates
 *     both numbers, so the ratio survives runner load; only a real change in
 *     how much work an interaction does moves it. Exceeding a budget fails.
 *
 *  2. **Absolute milliseconds — a warning.** Compared against the committed
 *     baseline. Useful as a trend, far too noisy across runner classes to
 *     block a merge on, so a regression here is reported, never fatal.
 *
 *  3. **Timeouts — the other gate.** A sample that never produced a visible
 *     result is not a slow sample, and percentiles skip it entirely. Past a
 *     small share of the run, the interaction is simply broken and its
 *     flattering p50 is an artifact of the few that worked.
 *
 * Usage:
 *   node compare-interactions.mjs --report FILE [--baseline FILE]
 *                                 [--summary FILE] [--update-baseline]
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { compareHiddenBytes } from './lib/compare-bytes.mjs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (flag) => argv.includes(flag);

const REPORT = opt('--report', 'tests/perf/interaction-report.json');
const BASELINE = opt('--baseline', 'tests/perf/interaction-baseline.json');
const SUMMARY = opt('--summary', process.env.GITHUB_STEP_SUMMARY || null);
const UPDATE = has('--update-baseline');

/**
 * How many keystroke round trips each interaction may cost: ceilings that
 * catch a step change (an extra round trip, a synchronous subprocess batch on
 * the path), not targets. The `measured` notes are today's cost (docs/
 * PERFORMANCE.md, Axis C).
 */
const RATIO_BUDGETS = {
  'key-echo': 1.5, // the reference, compared against itself
  // The last key of 30 typed 60 ms apart. Keys that queue behind one another
  // put it a round trip further back per key: over a 150 ms link, with each
  // POST waiting for the answer to the one before it, this measured 15×.
  'key-burst': 3, // measured ~1×, on the bare link and over 150 ms
  // 3× leaves room for noise while still failing loudly if navigation ever
  // loses its optimistic prediction again — un-predicted, it measured 12×.
  'pane-nav-keyboard': 3, // measured ~0.3×
  'pane-zoom-toggle': 5, // measured ~2.4×
  'pane-split': 5, // measured ~2.0×
  'tab-switch': 4, // measured ~0.1× — the optimistic prediction paints at once
  // The keystroke with 23 panes beside it each redrawing a spinner at ~2 KB/s:
  // measured 1.1–1.8× on a loaded dev machine, p95 nearer 2×.
  'key-echo-busy': 3,
  // Navigation start to the focused pane's prompt, and to the first key
  // echoed, with 10k lines of scrollback: measured ~12× and ~17×.
  'attach-paint': 30,
  'attach-interactive': 40,
  // A first wheel scroll over 10k lines of history to the rows in view
  // loaded: ~2.5× since history comes newest first (it was ~11×).
  'attach-scroll': 6,
};

/** Absolute p50 growth over the baseline that earns a warning line. */
const ABSOLUTE_WARN_RATIO = 1.5;

/**
 * The share of samples that may time out before the interaction fails.
 * Percentiles cover only the samples that landed, so a mostly-timing-out
 * interaction would report a fast p50 from the handful that worked.
 */
const MAX_TIMEOUT_RATIO = 0.25;

function load(path, what) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`could not parse ${what} at ${path}: ${e.message}`);
    return null;
  }
}

const report = load(REPORT, 'report');
if (!report) {
  console.error(`no report at ${REPORT}`);
  process.exit(2);
}
// A `perf:hidden-bytes` report has a budget of its own, and no baseline.
if (report.kind === 'hidden-bytes') {
  const { lines, failures } = compareHiddenBytes(report);
  const out = lines.join('\n');
  console.log(out);
  if (SUMMARY) appendFileSync(SUMMARY, `${out}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}
/**
 * Baselines are keyed by platform and target: a macOS laptop says nothing
 * about an `ubuntu-latest` runner, and the desktop app's Tauri IPC nothing
 * about the web app's POST + SSE on the same machine. Reports older than the
 * desktop harness have no `target` and were all web.
 */
const baselineKey = (r) => `${r.platform}/${r.target ?? 'web'}`;

const baselineFile = load(BASELINE, 'baseline');
const key = baselineKey(report);
const baselineForPlatform = baselineFile?.platforms?.[key] ?? null;
const baseById = new Map((baselineForPlatform?.interactions ?? []).map((i) => [i.name, i]));

const rows = [];
const failures = [];
const warnings = [];

for (const item of report.interactions) {
  const budget = RATIO_BUDGETS[item.name];
  const base = baseById.get(item.name);
  const ratio = item.ratioToReference;

  let verdict = '✅';
  if (budget != null && ratio != null && ratio > budget) {
    verdict = '❌';
    failures.push(
      `${item.name}: ${ratio}× the keystroke round trip (budget ${budget}×, p50 ${item.p50} ms)`,
    );
  }
  if (base?.p50 && item.p50 && item.p50 > base.p50 * ABSOLUTE_WARN_RATIO) {
    if (verdict === '✅') verdict = '⚠️';
    warnings.push(
      `${item.name}: p50 ${item.p50} ms vs baseline ${base.p50} ms (+${Math.round(
        (item.p50 / base.p50 - 1) * 100,
      )}%)`,
    );
  }
  // Judged before the ratio is believed at all: percentiles computed over the
  // few samples that survived describe nothing.
  const attempted = item.samples + item.timeouts;
  if (item.timeouts > 0) {
    const share = attempted > 0 ? item.timeouts / attempted : 1;
    if (share > MAX_TIMEOUT_RATIO) {
      verdict = '❌';
      failures.push(
        `${item.name}: ${item.timeouts} of ${attempted} samples never produced a visible result ` +
          `(${Math.round(share * 100)}%, limit ${Math.round(MAX_TIMEOUT_RATIO * 100)}%) — ` +
          `the interaction is not working, so its ${item.p50} ms p50 describes only the ones that did`,
      );
    } else {
      warnings.push(`${item.name}: ${item.timeouts} sample(s) never produced a visible result`);
    }
  }

  // Keys typed during an attach that never arrived (`lib/attach.mjs`): the
  // page holds them until it connects, so one lost is a regression.
  if (item.load?.lostKeys > 0) {
    verdict = '❌';
    failures.push(
      `${item.name}: ${item.load.lostKeys} of ${item.load.typedKeys} keys typed during the attach never arrived`,
    );
  }

  rows.push({
    verdict,
    name: item.name,
    p50: item.p50,
    p95: item.p95,
    ratio,
    budget: budget ?? null,
    basisP50: base?.p50 ?? null,
    samples: item.samples,
    timeouts: item.timeouts,
  });
}

const fmt = (v, suffix = '') => (v == null ? '—' : `${v}${suffix}`);
const table = [
  '| | interaction | p50 | p95 | × keystroke | budget | baseline p50 | samples | timed out |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map(
    (r) =>
      `| ${r.verdict} | \`${r.name}\` | ${fmt(r.p50, ' ms')} | ${fmt(r.p95, ' ms')} | ` +
      `${fmt(r.ratio, '×')} | ${fmt(r.budget, '×')} | ${fmt(r.basisP50, ' ms')} | ${r.samples} | ` +
      `${r.timeouts > 0 ? `**${r.timeouts}**` : '0'} |`,
  ),
].join('\n');

const lines = [
  `### Interaction latency — \`${report.target ?? 'web'}\` — \`${report.label}\` @ \`${report.commit ?? 'unknown'}\``,
  '',
  table,
  '',
  `Ratios are against \`${report.reference}\` measured in the same run, which is what makes them`,
  'comparable across runners. Raw milliseconds are a trend only.',
  baselineForPlatform
    ? `Baseline: \`${baselineForPlatform.commit ?? 'unknown'}\` on \`${key}\`.`
    : `No \`${key}\` baseline recorded yet — absolute comparison skipped.`,
];
if (failures.length) lines.push('', '**Over budget**', ...failures.map((f) => `- ${f}`));
if (warnings.length) lines.push('', '**Warnings**', ...warnings.map((w) => `- ${w}`));

const out = lines.join('\n');
console.log(out);
if (SUMMARY) appendFileSync(SUMMARY, `${out}\n`);

if (UPDATE) {
  const next = { schema: 1, platforms: { ...(baselineFile?.platforms ?? {}) } };
  next.platforms[key] = report;
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nupdated ${key} baseline → ${BASELINE}`);
}

process.exit(failures.length === 0 ? 0 : 1);
