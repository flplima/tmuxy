#!/usr/bin/env node
/**
 * Build the plugin index: every public GitHub repository with the topic
 * `tmuxy-plugin` whose manifests pass `tmuxy plugin check` (docs/PLUGINS.md,
 * "The index"). Run every six hours by .github/workflows/plugin-index.yml,
 * which publishes the result on the `plugin-index` branch.
 *
 * Usage:
 *   node bin/plugin-index.mjs --tmuxy <server binary> --out plugins.json
 *       [--repos fixture.json] [--summary summary.md]
 *
 * Without --repos the repositories come from the GitHub search API through
 * `gh` (GH_TOKEN). A fixture lists the same fields the API answers
 * (`full_name`, `default_branch`, `stargazers_count`, `pushed_at`) plus a
 * `clone_url`, so a test runs on local repositories.
 *
 * Each repository is cloned shallow at its default branch's head, with
 * hooks, filters and submodules off, and every `tmuxy-plugin.toml` in it
 * (at the root or up to three directories down) is checked by the binary.
 * A repository whose manifests all fail is left out and named in the
 * summary with why. Two entries with one name are both kept and marked
 * `duplicate`: they install by their source.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const opts = args(process.argv.slice(2));
if (!opts.tmuxy || !opts.out) {
  console.error('usage: plugin-index.mjs --tmuxy <bin> --out <file> [--repos f] [--summary f]');
  process.exit(2);
}

/** The repositories to index, from a fixture or the search API. */
function repositories() {
  if (opts.repos) return JSON.parse(fs.readFileSync(opts.repos, 'utf8'));
  const pages = execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      '-X',
      'GET',
      'search/repositories',
      '-f',
      'q=topic:tmuxy-plugin is:public archived:false',
      '-f',
      'per_page=100',
      '--jq',
      '.items[]',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return pages
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** git with nothing in the repository able to run code. */
function git(cwd, ...argv) {
  const local = opts.repos ? ['-c', 'protocol.file.allow=always'] : [];
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.symlinks=false',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false',
      ...local,
      ...argv,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
    },
  ).trim();
}

/** Directories holding a manifest: the root and up to three levels down. */
function manifestDirs(root, depth = 0, acc = []) {
  if (fs.existsSync(path.join(root, 'tmuxy-plugin.toml'))) acc.push(root);
  if (depth >= 3) return acc;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      manifestDirs(path.join(root, entry.name), depth + 1, acc);
    }
  }
  return acc;
}

/** `tmuxy plugin check --json` on one directory: the answer, ok or not. */
function check(dir) {
  try {
    return JSON.parse(
      execFileSync(opts.tmuxy, ['plugin', 'check', dir, '--json'], { encoding: 'utf8' }),
    );
  } catch (e) {
    const out = (e.stdout || '').toString().trim();
    try {
      return JSON.parse(out);
    } catch {
      return { ok: false, error: (e.stderr || e.message).toString().trim() };
    }
  }
}

const plugins = [];
const excluded = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-plugin-index-'));
for (const repo of repositories()) {
  const source = repo.full_name;
  const dest = path.join(scratch, source.replace('/', '__'));
  try {
    const url = repo.clone_url || `https://github.com/${source}.git`;
    git(
      scratch,
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--no-tags',
      '--single-branch',
      '--no-recurse-submodules',
      '--branch',
      repo.default_branch,
      '--',
      url,
      dest,
    );
  } catch (e) {
    excluded.push({ source, reason: `clone failed: ${e.message.split('\n')[0]}` });
    continue;
  }
  const sha = git(dest, 'rev-parse', 'HEAD');
  const dirs = manifestDirs(dest);
  if (dirs.length === 0) {
    excluded.push({ source, reason: 'no tmuxy-plugin.toml' });
    continue;
  }
  for (const dir of dirs) {
    const sub = path.relative(dest, dir);
    const where = sub ? `${source}/${sub}` : source;
    const answer = check(dir);
    if (!answer.ok) {
      excluded.push({ source: where, reason: answer.error || 'check failed' });
      continue;
    }
    plugins.push({
      name: answer.name,
      description: answer.description || '',
      source: where,
      sha,
      stars: repo.stargazers_count || 0,
      updated: repo.pushed_at || '',
      capabilities: answer.capabilities || [],
      platforms: answer.platforms || [],
    });
  }
}
fs.rmSync(scratch, { recursive: true, force: true });

const counts = new Map();
for (const p of plugins) counts.set(p.name, (counts.get(p.name) || 0) + 1);
for (const p of plugins) if (counts.get(p.name) > 1) p.duplicate = true;
plugins.sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));

const index = { generated: new Date().toISOString(), plugins, excluded };
fs.writeFileSync(opts.out, JSON.stringify(index, null, 2) + '\n');

if (opts.summary) {
  const lines = [
    `## Plugin index`,
    '',
    `${plugins.length} plugins indexed, ${excluded.length} left out.`,
    '',
    ...(excluded.length
      ? [
          '| Left out | Why |',
          '| --- | --- |',
          ...excluded.map(
            (e) => `| ${e.source} | ${e.reason.replaceAll('|', '\\|').split('\n')[0]} |`,
          ),
        ]
      : []),
  ];
  fs.appendFileSync(opts.summary, lines.join('\n') + '\n');
}
console.log(`${plugins.length} plugins indexed, ${excluded.length} left out`);
