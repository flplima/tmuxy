#!/usr/bin/env node
/**
 * Collect the criterion results of the `core_pipeline` bench and compare them
 * against a stored baseline (docs/PERFORMANCE.md, Axis A).
 *
 * Criterion writes one `estimates.json` per benchmark id under
 * `target/criterion/<id>/new/`; this walks that tree, so it picks up
 * `full_sync`, `delta_rename` and each `output_burst/<lines>` point without
 * naming them here — a bench added to core_pipeline.rs shows up on its own.
 *
 * Two signals, with very different standing — the same split as
 * compare-interactions.mjs (Axis C):
 *
 *  1. **Absolute nanoseconds vs. the stored baseline — a warning.** A shared
 *     GitHub runner is far too noisy to gate a merge on (the same commit can
 *     vary two-fold between runs), and a platform with no baseline recorded
 *     has nothing to compare against at all. Reported as a ::warning and in
 *     the job summary; never fatal.
 *
 *  2. **Ratios between benchmarks in the SAME run — the gate.** A slow runner
 *     inflates both halves of a ratio, so it survives runner load, and it
 *     needs no baseline: it is a statement about the shape of the pipeline,
 *     not its speed. Exceeding one fails.
 *
 * Usage:
 *   node perf/compare-core-bench.mjs [--criterion-dir target/criterion]
 *                                    [--baseline perf/core-pipeline-baseline.json]
 *                                    [--out perf/core-pipeline-report.json]
 *                                    [--threshold 20] [--update-baseline]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const CRITERION_DIR = opt('--criterion-dir', 'target/criterion');
const BASELINE = opt('--baseline', 'perf/core-pipeline-baseline.json');
const OUT = opt('--out', 'perf/core-pipeline-report.json');
const THRESHOLD = Number(opt('--threshold', '20'));
const UPDATE = has('--update-baseline');

/**
 * Ratios between two benchmarks of the same run, and the ceiling each may
 * reach. These are the part of this script that can fail a build.
 *
 * A ratio is machine-independent — a loaded runner inflates numerator and
 * denominator together — so unlike the absolute numbers it needs no baseline
 * and means the same thing on every platform. Each one encodes a structural
 * property of the pipeline that a refactor could silently destroy, which is
 * exactly what a criterion number alone cannot protect.
 *
 * Ceilings have headroom; they exist to catch a step change, not to police a
 * few percent. Raising one is a deliberate edit that shows up in review.
 */
const RATIO_BUDGETS = [
  {
    numerator: 'delta_rename',
    denominator: 'full_sync',
    budget: 0.4,
    // Measured ~0.17 with `TmuxPane.content: Arc<PaneContent>` and the
    // `ptr_eq` skip in the grid diff. Before those, every state update
    // deep-copied each pane's cell grid three times and a one-field delta
    // cost ~0.78 of a full snapshot — i.e. it scaled with grid size, which
    // is the pathology this ratio exists to keep from coming back.
    why: 'a metadata-only delta must not cost like a full snapshot',
  },
];

/** Every `<id>/new/estimates.json` under the criterion output tree. */
function collect(dir, prefix = [], found = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // `report` is criterion's HTML output; `base`/`change` are its own
    // saved-baseline bookkeeping, not a benchmark id.
    if (prefix.length === 0 && entry.name === 'report') continue;

    if (entry.name === 'new') {
      const estimates = path.join(dir, 'new', 'estimates.json');
      if (fs.existsSync(estimates) && prefix.length > 0) {
        const json = JSON.parse(fs.readFileSync(estimates, 'utf8'));
        found[prefix.join('/')] = {
          meanNs: round(json.mean?.point_estimate),
          medianNs: round(json.median?.point_estimate),
        };
      }
      continue;
    }
    if (entry.name === 'base' || entry.name === 'change') continue;

    collect(path.join(dir, entry.name), [...prefix, entry.name], found);
  }
  return found;
}

const round = (n) => (typeof n === 'number' ? Number(n.toPrecision(6)) : null);

const fmt = (ns) => {
  if (ns == null) return '—';
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(1)} µs`;
  return `${ns.toFixed(0)} ns`;
};

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout — the report is still valid */
}

const benchmarks = collect(CRITERION_DIR);
if (Object.keys(benchmarks).length === 0) {
  console.error(`no criterion estimates under ${CRITERION_DIR} — did the bench run?`);
  process.exit(1);
}

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  commit,
  platform: `${process.platform}-${process.arch}`,
  runner: process.env.RUNNER_NAME ?? null,
  benchmarks,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${OUT}`);

let baselineFile = null;
try {
  baselineFile = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
} catch {
  /* no baseline recorded yet */
}

// Like the interaction baseline, this is keyed by platform: nanoseconds from a
// macOS laptop say nothing about `ubuntu-latest`.
const baseline = baselineFile?.platforms?.[report.platform] ?? null;
const haveBaseline = baseline && Object.keys(baseline.benchmarks ?? {}).length > 0;

const lines = [
  '## core_pipeline bench (Axis A)',
  '',
  haveBaseline
    ? `Baseline: \`${baseline.commit ?? 'unknown'}\` on \`${report.platform}\`, warning at +${THRESHOLD}%.`
    : `No \`${report.platform}\` baseline recorded yet — numbers below are for the record only. See .github/workflows/nightly-perf.yml for how to seed one.`,
  '',
  '| benchmark | mean | baseline | change |',
  '| --- | ---: | ---: | ---: |',
];

let warnings = 0;
for (const [id, value] of Object.entries(benchmarks).sort(([a], [b]) => a.localeCompare(b))) {
  const before = haveBaseline ? baseline.benchmarks[id]?.meanNs : null;
  let change = '—';
  if (before && value.meanNs) {
    const pct = ((value.meanNs - before) / before) * 100;
    change = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    if (pct > THRESHOLD) {
      warnings += 1;
      change = `⚠️ ${change}`;
      console.log(
        `::warning title=core_pipeline ${id}::${fmt(value.meanNs)} vs baseline ${fmt(before)} (${change})`,
      );
    }
  }
  lines.push(`| \`${id}\` | ${fmt(value.meanNs)} | ${fmt(before)} | ${change} |`);
}

lines.push('');
lines.push(
  warnings > 0
    ? `${warnings} benchmark(s) over the +${THRESHOLD}% warning threshold. This never fails the job — CI runners are too noisy to gate on absolute numbers. Confirm on a quiet machine with \`cargo bench -p tmuxy-core\` before treating it as a regression.`
    : 'No benchmark over the warning threshold.',
);

// --- The gate: ratios within this run, which need no baseline ---
const failures = [];
const ratioRows = [];
for (const { numerator, denominator, budget, why } of RATIO_BUDGETS) {
  const top = benchmarks[numerator]?.meanNs;
  const bottom = benchmarks[denominator]?.meanNs;
  if (!top || !bottom) {
    // A renamed or removed bench must not silently drop its gate.
    failures.push(
      `${numerator} / ${denominator}: benchmark missing from this run — the ratio budget cannot be checked`,
    );
    ratioRows.push(`| \`${numerator}\` / \`${denominator}\` | — | ${budget} | ❌ | ${why} |`);
    continue;
  }
  const ratio = top / bottom;
  const over = ratio > budget;
  if (over) {
    failures.push(`${numerator} / ${denominator}: ${ratio.toFixed(3)} (budget ${budget}) — ${why}`);
    console.log(
      `::error title=core_pipeline ratio::${numerator}/${denominator} = ${ratio.toFixed(3)}, budget ${budget}`,
    );
  }
  ratioRows.push(
    `| \`${numerator}\` / \`${denominator}\` | ${ratio.toFixed(3)} | ${budget} | ${over ? '❌' : '✅'} | ${why} |`,
  );
}

if (ratioRows.length > 0) {
  lines.push(
    '',
    '### Ratio budgets (the gate)',
    '',
    '| ratio | measured | budget | | what it protects |',
    '| --- | ---: | ---: | --- | --- |',
    ...ratioRows,
    '',
    'Ratios are between benchmarks of this same run, so they survive runner load and need no baseline. These fail the job; the absolute numbers above never do.',
  );
}

const summary = lines.join('\n');
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (UPDATE) {
  const next = { schema: 1, platforms: { ...(baselineFile?.platforms ?? {}) } };
  next.platforms[report.platform] = report;
  fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nupdated ${report.platform} baseline → ${BASELINE}`);
}

if (failures.length > 0) {
  console.error(`\nratio budget exceeded:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
