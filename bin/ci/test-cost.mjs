#!/usr/bin/env node
/**
 * What the test suite costs, month by month — the two numbers that say
 * whether de-flaking work is paying off:
 *
 * - **minutes-to-green**: for every push to main, the minutes from its
 *   `lint and tests` run starting until main is next green (the first push at
 *   or after it whose run ends green, re-runs included). A slow suite and a
 *   red stretch both show up here, which is the point: either one is time
 *   nobody can ship.
 * - **test commits**: commits whose gitmoji is ✅ — work on the suite itself
 *   rather than on the product — and, of those, the **timing** ones that say
 *   they are about a wait, a race, a timeout, a flake or a quarantine. House
 *   commit subjects describe the behaviour, not the fix ("the phone layout
 *   waits for the grid…"), so the word list undercounts; the ✅ total is the
 *   upper bound.
 *
 *   bin/ci/test-cost.mjs              the last 6 months
 *   bin/ci/test-cost.mjs --months 12  further back (run history permitting)
 *   bin/ci/test-cost.mjs --summary    markdown, for $GITHUB_STEP_SUMMARY
 *
 * Needs `gh` with access to the repository and the git history.
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const markdown = args.includes('--summary');
const monthsArg = args.indexOf('--months');
const months = monthsArg === -1 ? 6 : Number(args[monthsArg + 1]);
if (!Number.isInteger(months) || months < 1) {
  console.error('usage: bin/ci/test-cost.mjs [--months N] [--summary]');
  process.exit(2);
}

const since = new Date();
since.setUTCDate(1);
since.setUTCMonth(since.getUTCMonth() - (months - 1));
since.setUTCHours(0, 0, 0, 0);
const monthOf = (iso) => iso.slice(0, 7);

const run = (cmd, argv) =>
  execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

// ---- minutes-to-green -------------------------------------------------------

const pages = run('gh', [
  'api',
  '--paginate',
  '--jq',
  '.workflow_runs[] | [.run_started_at, .updated_at, .conclusion] | @tsv',
  `repos/{owner}/{repo}/actions/workflows/lint-and-tests.yml/runs?branch=main&event=push&per_page=100&created=>=${since.toISOString().slice(0, 10)}`,
]);
const runs = pages
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [started, ended, conclusion] = line.split('\t');
    return { started: new Date(started), ended: new Date(ended), conclusion };
  })
  // A run still going has no conclusion yet and says nothing about either.
  .filter((r) => r.conclusion)
  .sort((a, b) => a.started - b.started);

const toGreen = new Map();
for (let i = 0; i < runs.length; i++) {
  const green = runs.slice(i).find((r) => r.conclusion === 'success');
  // Main has not been green since: this push's wait has not ended yet.
  if (!green) continue;
  const minutes = Math.max(0, (green.ended - runs[i].started) / 60000);
  const month = monthOf(runs[i].started.toISOString());
  if (!toGreen.has(month)) toGreen.set(month, { minutes: [], red: 0 });
  toGreen.get(month).minutes.push(minutes);
  if (runs[i].conclusion !== 'success') toGreen.get(month).red++;
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

// ---- test commits -------------------------------------------------------------

const TIMING_WORDS =
  /\b(flak\w*|de-?flake\w*|race\w*|timing|timeouts?|deadlines?|settl\w*|sleeps?|wait\w*|poll\w*|quarantin\w*|retr(y|ies))\b/i;

const log = run('git', [
  'log',
  `--since=${since.toISOString()}`,
  '--no-merges',
  '--format=%cI%x09%s',
]);
const commits = new Map();
for (const line of log.split('\n').filter(Boolean)) {
  const [date, subject] = line.split('\t');
  const month = monthOf(date);
  if (!commits.has(month)) commits.set(month, { all: 0, tests: 0, timing: 0 });
  const counts = commits.get(month);
  counts.all++;
  if (subject.startsWith('✅')) {
    counts.tests++;
    if (TIMING_WORDS.test(subject)) counts.timing++;
  }
}

// ---- report -------------------------------------------------------------------

const monthKeys = [...new Set([...toGreen.keys(), ...commits.keys()])].sort();
const row = (cells) => console.log(markdown ? `| ${cells.join(' | ')} |` : cells.join('  '));
const head = [
  'month',
  'pushes',
  'red',
  'to-green p50 (min)',
  'to-green p90 (min)',
  'commits',
  '✅ tests',
  'of which timing',
  '✅ %',
];
if (markdown) {
  console.log('### Test cost by month\n');
  row(head);
  console.log(`|${head.map(() => '---').join('|')}|`);
} else {
  row(head.map((h, i) => (i === 0 ? h.padEnd(7) : h)));
}
for (const month of monthKeys) {
  const g = toGreen.get(month);
  const c = commits.get(month) ?? { all: 0, tests: 0, timing: 0 };
  const fmt = (n) => (n === undefined ? '—' : n.toFixed(0));
  row([
    month,
    String(g?.minutes.length ?? 0),
    String(g?.red ?? 0),
    fmt(g && quantile(g.minutes, 0.5)),
    fmt(g && quantile(g.minutes, 0.9)),
    String(c.all),
    String(c.tests),
    String(c.timing),
    c.all ? `${Math.round((100 * c.tests) / c.all)}%` : '—',
  ]);
}
