import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every `file › title` in an `Enforced by` cell of docs/INVARIANTS*.md (and of
 * the capability catalog, docs/FEATURES*.md) names a
 * test that exists: a tracked file whose path ends in `file` holds `title`. A
 * title cut short with `…` is matched by its longest uncut piece, and a cell's
 * `› title` with no file reuses the file named before it. A test that moves to
 * another file, or is renamed, without its row following is an error here,
 * rather than a row that claims an enforcer nothing runs.
 */
const SOURCE = /\.(?:rs|ts|tsx|js|mjs|sh)$/;
const ROW = /^\|\s*[A-Z]+\d+\s*\|/;
const REFERENCE = /`([^`]*›[^`]*)`/g;

function longestPiece(title) {
  return title
    .split('…')
    .map((piece) => piece.trim().replace(/\.$/, ''))
    .reduce((a, b) => (b.length > a.length ? b : a), '');
}

export function checkInvariantEnforcers(root, addError) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const sources = tracked.filter((file) => SOURCE.test(file));
  const contents = new Map();
  const read = (file) => {
    if (!contents.has(file)) contents.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
    return contents.get(file);
  };

  for (const doc of tracked.filter((file) => /^docs\/(INVARIANTS|FEATURES).*\.md$/.test(file))) {
    read(doc)
      .split('\n')
      .forEach((line, index) => {
        if (!ROW.test(line)) return;
        const cells = line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|');
        const id = cells[0].trim();
        let file = null;
        for (const [, reference] of cells[cells.length - 1].matchAll(REFERENCE)) {
          const [named, ...rest] = reference.split('›');
          if (named.trim()) file = named.trim();
          const title = rest.join('›').trim();
          const needle = longestPiece(title);
          if (!file || !needle) continue;
          const candidates = sources.filter((f) => f === file || f.endsWith(`/${file}`));
          if (candidates.some((f) => read(f).includes(needle))) continue;
          const where = candidates.length
            ? `is not in ${candidates.join(', ')}`
            : 'names no tracked file';
          addError(
            `[invariants] ${doc}:${index + 1} ${id}: \`${file} › ${title}\` ${where}. ` +
              "Point the row's Enforced-by cell at the file and title the test has now.",
          );
        }
      });
  }
}
