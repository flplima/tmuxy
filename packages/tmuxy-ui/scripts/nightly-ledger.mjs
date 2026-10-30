#!/usr/bin/env node
/**
 * The nightly story sweep's verdict for tonight (`.github/workflows/nightly-v86.yml`).
 *
 *   node scripts/nightly-ledger.mjs \
 *     --sweep <results.json…> --reconfirm <results.json…> \
 *     --history <dir> --verdicts-out <file> --body-out <file>
 *
 * `--sweep` are tonight's probe results, `--reconfirm` the re-run of the
 * stories that failed, on a fresh runner (either may be missing: a job that
 * did not run wrote none). `--history` holds earlier nights' verdict files,
 * as this script wrote them (`{ date, verdicts: { id: verdict } }`).
 *
 * Writes tonight's verdicts (for tomorrow's history) and, when there is
 * something to report, the issue comment; prints the decision; and sets
 * `report=true|false` in `$GITHUB_OUTPUT` when that is set. The rules are
 * `lib/nightly-ledger.mjs`.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledger, mergeResults, reportBody, verdicts } from './lib/nightly-ledger.mjs';

function parseArgs(argv) {
  const out = { sweep: [], reconfirm: [], history: null, verdictsOut: null, bodyOut: null };
  let list = null;
  for (const arg of argv) {
    if (arg === '--sweep') list = out.sweep;
    else if (arg === '--reconfirm') list = out.reconfirm;
    else if (arg === '--history') list = 'history';
    else if (arg === '--verdicts-out') list = 'verdictsOut';
    else if (arg === '--body-out') list = 'bodyOut';
    else if (Array.isArray(list)) list.push(arg);
    else if (typeof list === 'string') out[list] = arg;
  }
  return out;
}

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined);

const args = parseArgs(process.argv.slice(2));
const sweepFiles = args.sweep.map(readJson);
const sweep = mergeResults(sweepFiles);
const reconfirm = mergeResults(args.reconfirm.map(readJson));
const tonight = verdicts(sweep, reconfirm);

// Earlier nights, newest first, by the date each file carries.
const history = [];
if (args.history && existsSync(args.history)) {
  for (const name of readdirSync(args.history, { recursive: true })) {
    if (!String(name).endsWith('.json')) continue;
    const file = readJson(join(args.history, String(name)));
    if (file?.verdicts) history.push(file);
  }
}
history.sort((a, b) => String(b.date).localeCompare(String(a.date)));
const nights = [tonight, ...history.map((h) => new Map(Object.entries(h.verdicts)))];

const result = ledger(nights);

if (args.verdictsOut) {
  writeFileSync(
    args.verdictsOut,
    JSON.stringify(
      { date: new Date().toISOString(), verdicts: Object.fromEntries(tonight) },
      null,
      2,
    ),
  );
}

const failures = new Map();
for (const file of sweepFiles) {
  for (const s of file?.stories ?? []) {
    if (!s.ok) failures.set(s.id, [s.reason, s.message].filter(Boolean).join(': '));
  }
}
if (result.report && args.bodyOut) {
  writeFileSync(
    args.bodyOut,
    reportBody(result, {
      runUrl: process.env.RUN_URL ?? '(no run url)',
      sha: process.env.GITHUB_SHA ?? '(no sha)',
      failures,
    }),
  );
}

console.log(`stories: ${tonight.size}, nights of history: ${history.length}`);
console.log(`confirmed failures: ${result.confirmed.join(', ') || 'none'}`);
console.log(`flaky tonight: ${result.flakyTonight.join(', ') || 'none'}`);
console.log(
  `flaky on ${2}+ recent nights: ${result.recurring.map((r) => `${r.id} (${r.nights})`).join(', ') || 'none'}`,
);
console.log(`report: ${result.report}`);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `report=${result.report}\n`);
