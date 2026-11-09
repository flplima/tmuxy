import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Each fact and each dangerous call has a home: the files that may write it
 * (bin/ci/homes.json). A fact the core generates for the UI and the CLI —
 * an option name, a state word, a window type — written out by hand
 * elsewhere is a copy that will drift, which is the tangle PR #177 undid; a
 * process started or tmux run from any file is a seam nobody reviewed.
 *
 * A rule names what it looks for (`literals`, or a `regex`), where (`scope`,
 * path prefixes; `ext`), and `allow`: the files that may, today's when the
 * rule came in. A new file that writes it fails; a file moved home is dropped
 * from the list, which only shrinks. Code lines only: comments, tests,
 * stories, fixtures and docs may say anything.
 *
 * `node bin/ci/homes.mjs --baseline` prints, per rule, the files that match
 * now: what `allow` is set to when a rule is added.
 */

const EXEMPT = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/|_)tests?(_[a-z0-9_]+)?\.rs$/,
  /\.stories\.tsx?$/,
  /\/stories\//,
  /\/fixtures\//,
  /\.md$/,
];

/** Lines that are code: comment lines dropped, by the file's language. */
export function codeLines(file, text) {
  const shell = !/\.[a-z]+$/.test(file) || file.endsWith('.sh');
  const comment = shell ? /^\s*#/ : /^\s*(\/\/|\/\*|\*)/;
  return text.split('\n').filter((line) => !comment.test(line));
}

/** Whether `file` (repo-relative) is in `rule`'s scope at all. */
export function inScope(rule, file) {
  if (EXEMPT.some((re) => re.test(file))) return false;
  if (!rule.scope.some((prefix) => file.startsWith(prefix))) return false;
  if (rule.ext && !rule.ext.some((ext) => file.endsWith(ext))) return false;
  return true;
}

/** Whether the code lines of `text` write what `rule` looks for. */
export function writes(rule, file, text) {
  const lines = codeLines(file, text);
  if (rule.regex) {
    const re = new RegExp(rule.regex);
    return lines.some((line) => re.test(line));
  }
  return lines.some((line) => rule.literals.some((literal) => line.includes(literal)));
}

/** The files in scope that write it, for every rule. */
export function scan(rules, files, read) {
  return rules.map((rule) => ({
    rule,
    found: files.filter((file) => inScope(rule, file) && writes(rule, file, read(file))),
  }));
}

/** What `scan` found that its rule does not allow, and allowances gone stale. */
export function verdicts(scanned) {
  const errors = [];
  for (const { rule, found } of scanned) {
    for (const file of found) {
      if (!rule.allow.includes(file)) {
        errors.push(
          `[homes] ${file} writes ${rule.id} (${rule.why}). Use the home it has (${rule.home}), or, if this file is a new home, add it to bin/ci/homes.json.`,
        );
      }
    }
    for (const file of rule.allow) {
      if (!found.includes(file)) {
        errors.push(
          `[homes] bin/ci/homes.json allows ${file} to write ${rule.id}, and it no longer does: drop it from the list.`,
        );
      }
    }
  }
  return errors;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/** The policy check (bin/check-repo-policy.mjs). */
export function checkHomes(root, addError) {
  const { rules } = JSON.parse(fs.readFileSync(path.join(root, 'bin/ci/homes.json'), 'utf8'));
  const read = (file) => {
    try {
      return fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      return '';
    }
  };
  for (const error of verdicts(scan(rules, trackedFiles(root), read))) addError(error);
}

if (process.argv[1] === new URL(import.meta.url).pathname && process.argv.includes('--baseline')) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const { rules } = JSON.parse(fs.readFileSync(path.join(root, 'bin/ci/homes.json'), 'utf8'));
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  for (const { rule, found } of scan(rules, trackedFiles(root), read)) {
    console.log(`${rule.id}: ${JSON.stringify(found)}`);
  }
}
