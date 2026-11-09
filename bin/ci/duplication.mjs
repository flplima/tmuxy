import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Copied code, counted: the same run of `WINDOW` code lines in two places is
 * one rule kept twice, which is how the codebase tangled before PR #177.
 * Lines are compared after trimming and collapsing their spacing, so a copy
 * re-indented is still a copy; blank lines, comments, imports and lines of
 * punctuation alone are not compared, since they repeat by nature.
 *
 * What is reported is the number of lines inside such runs, per language. It
 * may not grow: bin/ci/ratchets.json holds today's, and a change that removes
 * a copy lowers it there (`node bin/ci/duplication.mjs --update`).
 */

export const WINDOW = 8;

const LANGUAGES = {
  typescript: { scope: 'packages/tmuxy-ui/src/', ext: /\.tsx?$/ },
  rust: { scope: 'packages/', ext: /\.rs$/, notIn: 'packages/vt100/' },
  shell: { scope: 'packages/tmuxy-cli/bin/', ext: /(^|\/)[^.]+$|\.sh$/ },
};

const EXEMPT = [
  /(^|\/)tests?\//,
  /__tests__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/|_)tests?(_[a-z0-9_]+)?\.rs$/,
  /\.stories\.tsx?$/,
  /\/stories\//,
  /\.gen\.[a-z]+$/,
  /\/_options$/,
];

/** A line as compared, or null when it is not compared at all. */
export function normal(line) {
  const text = line.trim().replace(/\s+/g, ' ');
  if (text === '' || /^[\])}{([;,.]*$/.test(text)) return null;
  if (/^(\/\/|\/\*|\*|#(?!!))/.test(text)) return null;
  if (/^(import|use|export \{|export \* from|mod |pub mod |pub use )/.test(text)) return null;
  return text;
}

/**
 * The lines of `files` (a map of name → text) inside a run of `WINDOW`
 * compared lines that also appears somewhere else, as a count.
 */
export function duplicatedLines(files, window = WINDOW) {
  const seen = new Map();
  const units = Object.entries(files).map(([name, text]) => {
    const kept = [];
    text.split('\n').forEach((line, i) => {
      const n = normal(line);
      if (n !== null) kept.push({ n, i });
    });
    return { name, kept };
  });
  for (const { name, kept } of units) {
    for (let at = 0; at + window <= kept.length; at++) {
      const key = kept
        .slice(at, at + window)
        .map((k) => k.n)
        .join('\n');
      const places = seen.get(key) ?? [];
      places.push({ name, at });
      seen.set(key, places);
    }
  }
  const copied = new Map(units.map((u) => [u.name, new Set()]));
  for (const places of seen.values()) {
    if (places.length < 2) continue;
    for (const { name, at } of places) {
      for (let k = at; k < at + window; k++) copied.get(name).add(k);
    }
  }
  let total = 0;
  for (const lines of copied.values()) total += lines.size;
  return total;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/** Duplicated lines per language, over the tracked files. */
export function measure(root) {
  const tracked = trackedFiles(root);
  const result = {};
  for (const [language, { scope, ext, notIn }] of Object.entries(LANGUAGES)) {
    const files = {};
    for (const file of tracked) {
      if (!file.startsWith(scope) || (notIn && file.startsWith(notIn))) continue;
      if (!ext.test(file) || EXEMPT.some((re) => re.test(file))) continue;
      const full = path.join(root, file);
      if (!fs.existsSync(full)) continue;
      files[file] = fs.readFileSync(full, 'utf8');
    }
    result[language] = duplicatedLines(files);
  }
  return result;
}

/** The policy check: no language's count above or below its ratchet. */
export function checkDuplication(root, addError) {
  const ratchets = JSON.parse(fs.readFileSync(path.join(root, 'bin/ci/ratchets.json'), 'utf8'));
  const now = measure(root);
  for (const [language, count] of Object.entries(now)) {
    const limit = ratchets.duplicatedLines[language];
    if (count > limit) {
      addError(
        `[duplication] ${language} has ${count} lines in copied runs of ${WINDOW}, over the ${limit} allowed (bin/ci/ratchets.json). Share the code instead of copying it.`,
      );
    } else if (count < limit) {
      addError(
        `[duplication] ${language} is down to ${count} copied lines from ${limit}: lower duplicatedLines.${language} in bin/ci/ratchets.json to ${count} (node bin/ci/duplication.mjs --update), so it stays down.`,
      );
    }
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const now = measure(root);
  if (process.argv.includes('--update')) {
    const file = path.join(root, 'bin/ci/ratchets.json');
    const ratchets = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    ratchets.duplicatedLines = now;
    fs.writeFileSync(file, `${JSON.stringify(ratchets, null, 2)}\n`);
  }
  console.log(JSON.stringify(now));
}
