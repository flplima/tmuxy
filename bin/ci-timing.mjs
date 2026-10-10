#!/usr/bin/env node
/**
 * Where a `lint and tests` run spent its time: every job by wall clock, the
 * slowest steps, and the slowest individual tests read out of the job logs.
 *
 *   bin/ci-timing.mjs <run-id>             print it
 *   bin/ci-timing.mjs <run-id> --summary   markdown, for $GITHUB_STEP_SUMMARY
 *
 * The run's own `timing` job writes the summary onto every run, so the
 * question "what got slower?" has an answer on the run page rather than a
 * green tick. Needs `gh` with access to the repository (GH_TOKEN on a runner).
 */
import { execFileSync } from 'node:child_process';

const [run, mode] = process.argv.slice(2);
if (!run) {
  console.error('usage: bin/ci-timing.mjs <run-id> [--summary]');
  process.exit(2);
}
const markdown = mode === '--summary';

const gh = (...args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const api = (path) => gh('api', '--paginate', path);

const jobs = JSON.parse(api(`repos/{owner}/{repo}/actions/runs/${run}/jobs?per_page=100`)).jobs;
const seconds = (a, b) => Math.round((new Date(b) - new Date(a)) / 1000);
const wall = (j) => (j.completed_at ? seconds(j.started_at, j.completed_at) : 0);

const heading = (text) => console.log(markdown ? `\n### ${text}\n` : `\n## ${text}\n`);
const row = (cells) => console.log(markdown ? `| ${cells.join(' | ')} |` : cells.join('  '));
const tableHead = (cells) => {
  if (!markdown) return;
  row(cells);
  console.log(`|${cells.map(() => '---').join('|')}|`);
};

heading('Jobs by wall time');
tableHead(['s', 'job', 'conclusion']);
for (const j of [...jobs].sort((a, b) => wall(b) - wall(a))) {
  row([String(wall(j)).padStart(5), j.name, j.conclusion ?? j.status]);
}

heading('Slowest steps');
const steps = jobs.flatMap((j) =>
  (j.steps ?? [])
    .filter((s) => s.completed_at && !/^(Set up|Complete|Post )/.test(s.name))
    .map((s) => ({ job: j.name, name: s.name, s: seconds(s.started_at, s.completed_at) })),
);
tableHead(['s', 'job', 'step']);
for (const s of steps.sort((a, b) => b.s - a.s).slice(0, 20)) {
  row([String(s.s).padStart(5), s.job, s.name]);
}

// Jest prints `✓ name (1234 ms)`; the probe prints `PASS  id (1.2s)`.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const JEST = /^\s+[✓✕√×]\s+(.+?)\s+\((\d+(?:\.\d+)?)\s*(ms|s)\)\s*$/;
const PROBE = /^\s+(?:PASS|FAIL|FLAKY)\s+(\S+).*?\((\d+(?:\.\d+)?)s\)\s*$/;
const tests = [];
for (const j of jobs) {
  if (!/e2e|cli-tests|desktop|storybook-probe/.test(j.name)) continue;
  let log = '';
  try {
    log = gh('api', '--allow-escape-sequences', `repos/{owner}/{repo}/actions/jobs/${j.id}/logs`);
  } catch {
    continue;
  }
  for (const raw of log.split('\n')) {
    const line = raw.replace(ANSI, '').replace(/^\S+Z /, '');
    const m = line.match(JEST);
    if (m) {
      tests.push({ job: j.name, name: m[1], s: m[3] === 's' ? Number(m[2]) : Number(m[2]) / 1000 });
      continue;
    }
    const p = line.match(PROBE);
    if (p) tests.push({ job: j.name, name: p[1], s: Number(p[2]) });
  }
}

heading(`Slowest tests (${tests.length} timed)`);
tableHead(['s', 'job', 'test']);
for (const t of tests.sort((a, b) => b.s - a.s).slice(0, 30)) {
  row([t.s.toFixed(1).padStart(6), t.job, t.name]);
}
