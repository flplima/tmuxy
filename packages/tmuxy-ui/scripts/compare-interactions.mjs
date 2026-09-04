#!/usr/bin/env node
/**
 * Interaction-latency gate + trend report.
 *
 * Reads a report from `measure-interactions.mjs` and judges it two ways,
 * because the two signals in it have very different noise floors:
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
 * Usage:
 *   node compare-interactions.mjs --report FILE [--baseline FILE]
 *                                 [--summary FILE] [--update-baseline]
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (flag) => argv.includes(flag);

const REPORT = opt('--report', 'perf/interaction-report.json');
const BASELINE = opt('--baseline', 'perf/interaction-baseline.json');
const SUMMARY = opt('--summary', process.env.GITHUB_STEP_SUMMARY || null);
const UPDATE = has('--update-baseline');

/**
 * How many keystroke round trips each interaction is allowed to cost.
 *
 * These are ceilings with headroom, not targets — they exist to catch a step
 * change (an extra round trip, a synchronous subprocess batch landing on the
 * path), not to police a few percent. Raising one is a deliberate act that
 * shows up in review; tightening one belongs in the commit that earns it.
 *
 * The `measured` note on each line is what the interaction actually costs
 * today (see PERFORMANCE.md § Interaction latency). Where measured sits well
 * under the ceiling there is room for runner noise; where it sits close, the
 * interaction is known-slow and the ceiling is holding the line rather than
 * endorsing the number.
 */
const RATIO_BUDGETS = {
  'key-echo': 1.5, // the reference, compared against itself
  // 3× leaves room for noise while still failing loudly if navigation ever
  // loses its optimistic prediction again — un-predicted, it measured 12×.
  'pane-nav-keyboard': 3, // measured ~0.3×
  'pane-zoom-toggle': 5, // measured ~2.4×
  'pane-split': 5, // measured ~2.0×
  'tab-switch': 4, // measured ~0.1× — the optimistic prediction paints at once
};

/** Absolute p50 growth over the baseline that earns a warning line. */
const ABSOLUTE_WARN_RATIO = 1.5;

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
// Baselines are keyed by platform. Milliseconds measured on a macOS laptop say
// nothing about an `ubuntu-latest` runner, so a report is only ever compared
// against a baseline recorded on the same platform; on a platform with no
// baseline yet, the absolute-millisecond column is simply blank and the ratio
// gate carries the run on its own.
const baselineFile = load(BASELINE, 'baseline');
const baselineForPlatform = baselineFile?.platforms?.[report.platform] ?? null;
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
  if (item.timeouts > 0) {
    warnings.push(`${item.name}: ${item.timeouts} sample(s) never produced a visible result`);
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
  });
}

const fmt = (v, suffix = '') => (v == null ? '—' : `${v}${suffix}`);
const table = [
  '| | interaction | p50 | p95 | × keystroke | budget | baseline p50 | samples |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map(
    (r) =>
      `| ${r.verdict} | \`${r.name}\` | ${fmt(r.p50, ' ms')} | ${fmt(r.p95, ' ms')} | ` +
      `${fmt(r.ratio, '×')} | ${fmt(r.budget, '×')} | ${fmt(r.basisP50, ' ms')} | ${r.samples} |`,
  ),
].join('\n');

const lines = [
  `### Interaction latency — \`${report.label}\` @ \`${report.commit ?? 'unknown'}\``,
  '',
  table,
  '',
  `Ratios are against \`${report.reference}\` measured in the same run, which is what makes them`,
  'comparable across runners. Raw milliseconds are a trend only.',
  baselineForPlatform
    ? `Baseline: \`${baselineForPlatform.commit ?? 'unknown'}\` on \`${report.platform}\`.`
    : `No \`${report.platform}\` baseline recorded yet — absolute comparison skipped.`,
];
if (failures.length) lines.push('', '**Over budget**', ...failures.map((f) => `- ${f}`));
if (warnings.length) lines.push('', '**Warnings**', ...warnings.map((w) => `- ${w}`));

const out = lines.join('\n');
console.log(out);
if (SUMMARY) appendFileSync(SUMMARY, `${out}\n`);

if (UPDATE) {
  const next = { schema: 1, platforms: { ...(baselineFile?.platforms ?? {}) } };
  next.platforms[report.platform] = report;
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nupdated ${report.platform} baseline → ${BASELINE}`);
}

process.exit(failures.length === 0 ? 0 : 1);
