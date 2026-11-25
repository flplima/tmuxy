#!/usr/bin/env node
/**
 * The nightly tmux matrix's verdict (.github/workflows/nightly-tmux-matrix.yml,
 * docs/NIGHTLY-SWEEP.md § "When the nightly matrix reports").
 *
 *   bin/ci/nightly-matrix.mjs failed-files <jest.json…>
 *       the test files with a failure, on one line: what to run again
 *
 *   bin/ci/nightly-matrix.mjs collect --version <v> [--soft]
 *       --sweep <step>=<jest.json>… --reconfirm <jest.json>…
 *       --step <step>=<outcome>… --out <file>
 *       one tmux version's night, written to --out; prints its summary and
 *       sets `confirmed` and `flaky` in $GITHUB_OUTPUT. A --step with a
 *       --sweep file is a jest run, one without is not (`core`, `server`).
 *       Nothing is written when no step ran.
 *
 *   bin/ci/nightly-matrix.mjs report --results <dir> --expect <v,v…> --soft <v…>
 *       --history <dir> --verdicts-out <file> --body-out <file>
 *       the night over every version; sets `report` and `fail` in
 *       $GITHUB_OUTPUT
 *
 * The verdict rules are the story sweep's
 * (packages/tmuxy-ui/scripts/lib/nightly-ledger.mjs). Everything but the CLI
 * is pure and exported for its test (nightly-matrix.test.mjs, beside it).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  ledger,
  mergeResults,
  verdicts,
} from '../../packages/tmuxy-ui/scripts/lib/nightly-ledger.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const MESSAGE_LIMIT = 300;
const STACK_LINE = /^\s+at /;
const CODE_FRAME_LINE = /^\s*>?\s*\d+ \|/;
/** A comment holds 65536 characters, and a broken server fails every test. */
const LIST_LIMIT = 40;
const DOC = 'docs/NIGHTLY-SWEEP.md § "When the nightly matrix reports"';

/**
 * What a failure says, on one line, without colours, cut short: the lines
 * before its stack, which is where a matcher puts what it expected and what it
 * got. A text with a code frame keeps its first line only.
 */
export function failureText(text) {
  const lines = stripVTControlCharacters(String(text ?? '')).split('\n');
  const stack = lines.findIndex((line) => STACK_LINE.test(line));
  const said = (stack < 0 ? lines : lines.slice(0, stack)).filter((line) => line.trim());
  const kept = said.some((line) => CODE_FRAME_LINE.test(line)) ? said.slice(0, 1) : said;
  const joined = kept.map((line) => line.trim()).join(' ');
  return joined.length > MESSAGE_LIMIT ? `${joined.slice(0, MESSAGE_LIMIT - 1)}…` : joined;
}

const failed = (assertion) => assertion.status === 'failed';

/** A file that failed with no failed assertion could not run (or a hook of its own broke). */
const couldNotRun = (suite) =>
  suite.status === 'failed' && !(suite.assertionResults ?? []).some(failed);

/**
 * The entries of one jest `--json` result: one per test that passed or
 * failed, with the id `<file> › <describe> › <test>`, the same on every tmux version,
 * and one with the file as its id for a file that could not run. With
 * `files`, a file that did run gets that entry too, passing: the second run
 * has to be able to say so.
 */
export function stories(data, { root = ROOT, files = false } = {}) {
  const out = [];
  for (const suite of data?.testResults ?? []) {
    const file = relative(root, suite.name);
    if (couldNotRun(suite)) out.push({ id: file, ok: false, message: failureText(suite.message) });
    else if (files) out.push({ id: file, ok: true });
    for (const a of suite.assertionResults ?? []) {
      if (a.status !== 'passed' && !failed(a)) continue;
      const entry = { id: [file, ...a.ancestorTitles, a.title].join(' › '), ok: !failed(a) };
      if (failed(a)) entry.message = failureText(a.failureMessages?.[0]);
      out.push(entry);
    }
  }
  return out;
}

/** The repo-relative test files with a failure in any of these jest results. */
export function failedFiles(results, { root = ROOT } = {}) {
  const files = results
    .flatMap((data) => data?.testResults ?? [])
    .filter((s) => s.status === 'failed' || (s.assertionResults ?? []).some(failed))
    .map((s) => relative(root, s.name));
  return [...new Set(files)].sort();
}

/** A step that ran and did not succeed; a cancelled one (the job's timeout) told us nothing. */
const broke = (outcome) => outcome === 'failure' || outcome === 'cancelled';

/**
 * One version's night. `steps` is each step's outcome; `sweep` maps a jest
 * step to its results (undefined when it wrote none). A step that broke
 * without naming a failure is a failure itself, with nothing to run again.
 * Null when no step ran: the job died before its suites, which `report`
 * learns from the missing file.
 */
export function collect({ version, soft = false, steps = {}, sweep = {}, reconfirm = [], root }) {
  if (Object.values(steps).every((outcome) => !outcome || outcome === 'skipped')) return null;
  const first = Object.values(sweep).flatMap((data) => stories(data, { root }));
  for (const [step, outcome] of Object.entries(steps)) {
    if (!broke(outcome)) continue;
    if (!(step in sweep)) {
      first.push({ id: step, ok: false, message: `the step ended in ${outcome}` });
    } else if (!stories(sweep[step], { root }).some((s) => !s.ok)) {
      first.push({
        id: `${step}: failed without results`,
        ok: false,
        message: `the step ended in ${outcome} and named no failing test`,
      });
    }
  }
  return {
    version,
    soft,
    sweep: { stories: first },
    reconfirm: {
      stories: reconfirm.flatMap((data) => stories(data, { root, files: true })),
    },
  };
}

/** One version's verdict per id. */
const versionVerdicts = (record) =>
  verdicts(mergeResults([record.sweep]), mergeResults([record.reconfirm]));

/** Why each failing id of a version failed, from its first run. */
const messages = (record) =>
  new Map(
    (record.sweep?.stories ?? [])
      .filter((s) => !s.ok)
      .map((s) => [s.id, s.message ?? ''])
      .reverse(),
  );

/** Text as a Markdown code span, which also keeps an `@name` in it from notifying anyone. */
function code(text) {
  const runs = String(text).match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = runs.length > 0 ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function list(items, line) {
  const lines = items.slice(0, LIST_LIMIT).map(line);
  if (items.length > LIST_LIMIT) lines.push(`- … and ${items.length - LIST_LIMIT} more`);
  return lines;
}

const entryLine = ({ id, where, message }) =>
  `- ${code(id)} — ${where}${message ? ` — ${code(message)}` : ''}`;

const section = (heading, entries) =>
  entries.length > 0 ? [heading, '', ...list(entries, entryLine), ''] : [];

/** The job summary of one version's night, in Markdown. */
export function summary(record, steps = {}) {
  const verdictsHere = versionVerdicts(record);
  const why = messages(record);
  const of = (verdict) =>
    [...verdictsHere]
      .filter(([, v]) => v === verdict)
      .map(([id]) => ({ id, where: `tmux ${record.version}`, message: why.get(id) }));
  const confirmed = of('confirmed');
  const flaky = of('flaky');
  return [
    `### tmux ${record.version}`,
    '',
    '| step | result |',
    '| --- | --- |',
    ...Object.entries(steps).map(([step, outcome]) => `| ${step} | ${outcome || 'skipped'} |`),
    '',
    `${verdictsHere.size} results: ${confirmed.length} failed twice, ${flaky.length} flaky.`,
    '',
    ...section('**Failed twice**', confirmed),
    ...section('**Flaky** (passed when run again)', flaky),
  ].join('\n');
}

/**
 * Per id, over these versions: the worst verdict, the versions it failed on
 * (and which of those passed the second time), and one failure message.
 */
function fold(records) {
  const out = new Map();
  for (const record of records) {
    const why = messages(record);
    for (const [id, verdict] of versionVerdicts(record)) {
      const entry = out.get(id) ?? { verdict: 'pass', confirmedOn: [], flakyOn: [], message: '' };
      out.set(id, entry);
      if (verdict === 'pass') continue;
      entry[`${verdict}On`].push(record.version);
      if (verdict === 'confirmed' || entry.verdict === 'pass') {
        if (entry.verdict !== 'confirmed') entry.message = why.get(id) ?? '';
        entry.verdict = verdict;
      }
    }
  }
  return out;
}

/** The record of a version whose job left none. */
const dead = (version, soft) => ({
  version,
  soft,
  sweep: { stories: [{ id: `tmux ${version}: the job ended before its suites ran`, ok: false }] },
  reconfirm: { stories: [] },
});

function where({ confirmedOn, flakyOn }) {
  const versions = [...confirmedOn, ...flakyOn.map((v) => `${v} (flaky)`)];
  return `tmux ${versions.sort().join(', ')}`;
}

/**
 * The night's decision. `records` are the versions' files, `expect` the
 * versions the run covered, `soft` those that never block, `history` earlier
 * nights' folded verdicts (Maps id → verdict), newest first.
 */
export function decide({ records, expect = [], soft = [], history = [] }) {
  const seen = new Set(records.map((r) => r.version));
  const all = [
    ...records,
    ...expect.filter((v) => !seen.has(v)).map((v) => dead(v, soft.includes(v))),
  ];
  const isSoft = (r) => r.soft || soft.includes(r.version);
  const blocking = fold(all.filter((r) => !isSoft(r)));
  const upstream = fold(all.filter(isSoft));
  const tonight = new Map([...blocking].map(([id, e]) => [id, e.verdict]));
  const rules = ledger([tonight, ...history]);

  const entry = (folded) => (id) => {
    const e = folded.get(id);
    return { id, where: where(e), message: e.message };
  };
  const confirmed = rules.confirmed.map(entry(blocking));
  const recurring = rules.recurring.map((r) => ({
    ...entry(blocking)(r.id),
    nights: r.nights,
  }));
  const several = rules.flakyTonight
    .filter((id) => blocking.get(id).flakyOn.length >= 2)
    .filter((id) => !rules.recurring.some((r) => r.id === id))
    .map(entry(blocking));
  const head = [...upstream]
    .filter(([, e]) => e.verdict === 'confirmed')
    .map(([id]) => id)
    .sort()
    .map(entry(upstream));
  const reported = new Set([...recurring, ...several].map((e) => e.id));
  const oneOff = rules.flakyTonight.filter((id) => !reported.has(id)).map(entry(blocking));

  const fail = confirmed.length + recurring.length + several.length > 0;
  return {
    report: fail || head.length > 0,
    fail,
    confirmed,
    recurring,
    several,
    head,
    oneOff,
    verdicts: tonight,
    nightsKnown: rules.nightsKnown,
  };
}

/** The issue comment for a decision that reports something, in Markdown. */
export function reportBody(result, { runUrl, sha }) {
  const recurring = result.recurring.map((e) => ({
    ...e,
    where: `${e.nights} nights; tonight ${e.where}`,
  }));
  return [
    ...section(
      '**Failed twice** (in the suite and again when run alone): a defect in the product or the test.',
      result.confirmed,
    ),
    ...section(
      `**Flaky on several nights** (of the last ${result.nightsKnown}): it is racing something.`,
      recurring,
    ),
    ...section(
      '**Flaky on several versions tonight**: it depends on what ran before it, or it races everywhere.',
      result.several,
    ),
    ...section(
      '**tmux HEAD, non-blocking: upstream master** (failed twice; it does not fail the workflow).',
      result.head,
    ),
    `Run: ${runUrl}`,
    `Commit: ${sha}`,
    '',
    `The run's job summaries list each version's failures; its artifacts hold the server logs, the jest results and the action trace. See ${DOC}.`,
  ].join('\n');
}

/** `--flag value…` into `{ flag: [values] }`; arguments before a flag are under `_`. */
function parseArgs(argv) {
  const out = { _: [] };
  let list = out._;
  for (const arg of argv) {
    if (arg.startsWith('--')) list = out[arg.slice(2)] = [];
    else list.push(arg);
  }
  return out;
}

/** A results file, or undefined for one that is missing or cut short. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Every JSON file under `dir`, parsed. */
function readAll(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(join(dir, name)))
    .filter(Boolean);
}

const pairs = (values = []) =>
  Object.fromEntries(values.map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]));

const words = (values = []) => values.join(',').split(',').filter(Boolean);

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [name, value] of Object.entries(values)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function collectCommand(args) {
  const version = args.version?.[0];
  const out = args.out?.[0];
  if (!version || !out) throw new Error('collect needs --version and --out');
  const steps = pairs(args.step);
  const sweep = Object.fromEntries(
    Object.entries(pairs(args.sweep)).map(([step, path]) => [step, readJson(path)]),
  );
  const reconfirm = (args.reconfirm ?? []).map(readJson);
  const record = collect({ version, soft: 'soft' in args, steps, sweep, reconfirm });
  if (!record) {
    console.log(`### tmux ${version}\n\nThe job ended before its suites ran.`);
    output({ confirmed: true, flaky: false });
    return;
  }
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(summary(record, steps));
  const found = [...versionVerdicts(record).values()];
  output({ confirmed: found.includes('confirmed'), flaky: found.includes('flaky') });
}

function reportCommand(args) {
  const expect = words(args.expect);
  // With no version expected, a run in which nothing ran would read as clean.
  if (expect.length === 0) throw new Error('report needs --expect: the versions this run covered');
  const history = readAll(args.history?.[0])
    .filter((night) => night.verdicts)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map((night) => new Map(Object.entries(night.verdicts)));
  const result = decide({
    records: readAll(args.results?.[0]).filter((r) => r.version && r.sweep),
    expect,
    soft: words(args.soft),
    history,
  });
  if (args['verdicts-out']?.[0]) {
    const tonight = {
      date: new Date().toISOString(),
      verdicts: Object.fromEntries(result.verdicts),
    };
    writeFileSync(args['verdicts-out'][0], JSON.stringify(tonight, null, 2));
  }
  if (result.report && args['body-out']?.[0]) {
    const body = reportBody(result, {
      runUrl: process.env.RUN_URL ?? '(no run url)',
      sha: process.env.GITHUB_SHA ?? '(no sha)',
    });
    writeFileSync(args['body-out'][0], body);
  }
  console.log(`results: ${result.verdicts.size}, nights of history: ${history.length}`);
  for (const [label, entries] of [
    ['failed twice', result.confirmed],
    ['flaky on several nights', result.recurring],
    ['flaky on several versions', result.several],
    ['HEAD, non-blocking', result.head],
    ['one-off flakes, not reported', result.oneOff],
  ]) {
    console.log(`${label}: ${entries.length || 'none'}`);
    for (const line of list(entries, entryLine)) console.log(line);
  }
  console.log(`report: ${result.report}, fail: ${result.fail}`);
  output({ report: result.report, fail: result.fail });
}

const COMMANDS = {
  'failed-files': (args) => console.log(failedFiles(args._.map(readJson)).join(' ')),
  collect: collectCommand,
  report: reportCommand,
};

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const [verb, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(COMMANDS, verb)) {
    console.error(`usage: nightly-matrix ${Object.keys(COMMANDS).join('|')} …`);
    process.exit(2);
  }
  COMMANDS[verb](parseArgs(rest));
}
