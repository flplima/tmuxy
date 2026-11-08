import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every backticked path in the docs names a file the repo has, and every CI
 * job or workflow a triage doc names is one the workflows define.
 *
 * A path token is a backticked word with a `/` in it that ends in a source
 * extension. The docs spell most of them short — `host/command.rs`,
 * `components/menus/SpecMenu.tsx`, `tmuxy-core/src/host/prepare.rs` — so a
 * token is looked for under each of ROOTS in order, and fails only when none
 * holds it. Placeholders (`<`, `>`, `*`, `{`), URLs, spaces, `..`, and paths
 * outside the repo (`/`, `~`, `$`) mark a token as not a path. A path that
 * .gitignore covers is one the build makes, so it is taken as present.
 *
 * In docs/CI-TRIAGE.md and docs/TESTS-LAYERS.md the first cell of a
 * `Workflow job` / `CI job` table column, and anywhere a token shaped
 * `job (shard)` or `workflow / job`, names a job: the workflow's `name:`, a
 * key under its `jobs:`, an `e2e (<suite>)` shard from tests/e2e-suites.json
 * (or `e2e (<placeholder>)`), or `storybook-probe (n/m)`.
 */
const EXT = /\.(?:rs|ts|tsx|js|mjs|cjs|css|json|sh|md|toml|conf|ya?ml)$/;
const NOT_A_PATH = /[<>*{}$ ]|:\/\/|\.\.|^[/~]/;
export const PACKAGES = [
  'tmuxy-core',
  'tmuxy-server',
  'tmuxy-verbs',
  'tmuxy-tauri-app',
  'tmuxy-ui',
  'tmuxy-cli',
  'tmuxy-wasm',
  'tmuxy-demo',
  'tmuxy-pty',
  'vt100',
  'protocol-fixtures',
];
const ROOTS = [
  ...PACKAGES.map((pkg) => `packages/${pkg}/`),
  'packages/tmuxy-ui/src/',
  'packages/tmuxy-core/src/',
  'packages/tmuxy-server/src/',
  'packages/tmuxy-tauri-app/src/',
  'packages/tmuxy-cli/bin/tmuxy/',
];
const JOB_DOCS = ['docs/CI-TRIAGE.md', 'docs/TESTS-LAYERS.md'];
const JOB_COLUMN = /^(?:workflow job|ci job)$/i;
const SHAPED_JOB = /^(?:[\w.-]+ \(.+\)|.+ \/ .+)$/;

/** The token with the quoting and trailing punctuation a sentence adds taken off. */
export function cleanToken(raw) {
  return raw
    .trim()
    .replace(/^\.\//, '')
    .replace(/[),.:;]+$/, '')
    .replace(/#[\w-]*$/, '');
}

export function isPathToken(token) {
  return token.includes('/') && EXT.test(token) && !NOT_A_PATH.test(token);
}

/** The repo-relative path `token` resolves to: itself, `packages/` + itself when it starts with a package, then under each of ROOTS; null when nowhere. */
export function resolveDocPath(token, exists) {
  const first = token.slice(0, token.indexOf('/'));
  const candidates = [token];
  if (PACKAGES.includes(first)) candidates.push(`packages/${token}`);
  candidates.push(...ROOTS.map((root) => root + token));
  return candidates.find(exists) ?? null;
}

/** `[line, token]` for every backticked token on a line, 1-based. */
function backticked(content) {
  const out = [];
  content.split('\n').forEach((line, index) => {
    for (const [, raw] of line.matchAll(/`([^`]+)`/g)) out.push([index + 1, raw]);
  });
  return out;
}

/** The job and workflow names the workflows define, from their files. */
export function jobCatalog(root, suites) {
  const dir = path.join(root, '.github/workflows');
  const workflows = new Map();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.yml'))) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    const name = content.match(/^name:\s*(.+)$/m)?.[1].trim();
    const jobs = new Set();
    const body = content.split(/^jobs:\s*$/m)[1] ?? '';
    for (const [, key] of body.matchAll(/^ {2}([\w-]+):/gm)) jobs.add(key);
    workflows.set(name, { file, jobs });
  }
  return { workflows, shards: new Set([...suites.map((s) => s.name), 'nightly-tier']) };
}

/** Whether `token` names a job, a workflow, or a shard of one. */
export function isKnownJob(token, catalog) {
  const { workflows, shards } = catalog;
  const pair = token.match(/^(.+?) \/ (.+)$/);
  if (pair) {
    const wf = workflows.get(pair[1]);
    return Boolean(wf) && isKnownJob(pair[2], { workflows: new Map([[pair[1], wf]]), shards });
  }
  const sharded = token.match(/^([\w-]+) \((.+)\)$/);
  if (sharded) {
    const [, job, shard] = sharded;
    if (job === 'e2e') return shards.has(shard) || /^<[^>]+>$/.test(shard);
    if (job === 'storybook-probe') return /^\d+\/\d+$/.test(shard);
    return false;
  }
  for (const [name, { file, jobs }] of workflows) {
    if (token === name || token === file || jobs.has(token)) return true;
  }
  return false;
}

/** `[line, token]` for every backticked token of `content` that stands where a job name is expected. */
export function jobTokens(content) {
  const out = [];
  let column = -1;
  content.split('\n').forEach((line, index) => {
    const row = line.trim();
    const cells = row.startsWith('|') ? row.replace(/^\||\|$/g, '').split('|') : null;
    if (!cells) column = -1;
    else if (column === -1) {
      column = cells.findIndex((c) => JOB_COLUMN.test(c.trim()));
      return;
    }
    const tokens = [...row.matchAll(/`([^`]+)`/g)].map(([, t]) => t);
    const inColumn =
      cells && column >= 0 ? tokens.filter((t) => (cells[column] ?? '').includes(`\`${t}\``)) : [];
    const shaped = tokens.filter((t) => SHAPED_JOB.test(t));
    for (const token of new Set([...inColumn, ...shaped])) out.push([index + 1, token]);
  });
  return out;
}

function tracked(root, worktree) {
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean);
  const files = git(['ls-files']);
  if (worktree) files.push(...git(['ls-files', '--others', '--exclude-standard']));
  return new Set(files);
}

/** The paths of `candidates` that .gitignore covers, in one git call. */
function ignored(root, candidates) {
  if (!candidates.length) return new Set();
  try {
    return new Set(
      execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
        cwd: root,
        encoding: 'utf8',
        input: candidates.join('\n') + '\n',
      })
        .split('\n')
        .filter(Boolean),
    );
  } catch (error) {
    // Exit 1 is "none of them is ignored".
    if (error.status === 1) return new Set();
    throw error;
  }
}

/**
 * The docs checked: every `docs/*.md`, plus the instruction files and the
 * folder READMEs. With `worktree`, untracked files count as present, so a doc
 * can name a file that is not yet staged.
 */
export function checkDocPaths(root, addError, { worktree = false } = {}) {
  const files = tracked(root, worktree);
  const dirs = new Set();
  for (const file of files) {
    for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1))
      dirs.add(file.slice(0, i));
  }
  const exists = (p) => files.has(p) || dirs.has(p);
  const docs = [...files].filter(
    (f) => /^docs\/[^/]+\.md$/.test(f) || /(^|\/)(README|AGENTS|CONTRIBUTING)\.md$/.test(f),
  );

  const unresolved = [];
  for (const doc of docs) {
    for (const [line, raw] of backticked(fs.readFileSync(path.join(root, doc), 'utf8'))) {
      const token = cleanToken(raw);
      if (!isPathToken(token)) continue;
      if (resolveDocPath(token, exists) === null) unresolved.push({ doc, line, token });
    }
  }
  const generated = ignored(
    root,
    unresolved.map((u) => u.token),
  );
  for (const { doc, line, token } of unresolved) {
    if (generated.has(token)) continue;
    addError(`[docs] ${doc}:${line} references missing path: ${token}`);
  }

  const { suites } = JSON.parse(fs.readFileSync(path.join(root, 'tests/e2e-suites.json'), 'utf8'));
  const catalog = jobCatalog(root, suites);
  for (const doc of JOB_DOCS) {
    if (!files.has(doc)) continue;
    for (const [line, token] of jobTokens(fs.readFileSync(path.join(root, doc), 'utf8'))) {
      if (isPathToken(cleanToken(token)) || isKnownJob(token, catalog)) continue;
      addError(
        `[docs] ${doc}:${line} names a CI job or workflow that does not exist: ${token}. ` +
          'Job names are the keys under `jobs:` in .github/workflows/*.yml, workflow names their `name:`.',
      );
    }
  }
}
