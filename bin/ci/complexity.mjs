import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Functions grown past what one reading holds, counted: a function with many
 * branches or many lines is where unrelated rules end up sharing a body, the
 * start of a tangle. The counts may not grow (bin/ci/ratchets.json), and a
 * change that splits one lowers them (`node bin/ci/complexity.mjs --update`).
 *
 * TypeScript, over the UI's source without tests and stories: ESLint's own
 * `complexity` (more than `MAX_BRANCHES` paths) and `max-lines-per-function`
 * (more than `MAX_LINES` lines of code). Rust, over the crates' sources
 * without tests: functions whose body runs past `MAX_LINES` lines of code,
 * found by matching braces outside strings and comments.
 */

export const MAX_BRANCHES = 15;
export const MAX_LINES = 80;

const SKIP = /(__tests__|\.test\.|\.stories\.|\/stories\/|\/test\/)/;
const RUST_SKIP = /(^|\/)tests?\/|(^|\/|_)tests?(_[a-z0-9_]+)?\.rs$/;

/** Code text with comments and string contents blanked, line breaks kept. */
export function blankStringsAndComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (text[i] === '"') {
      out += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '"';
      i++;
    } else if (/r#*"/.test(text.slice(i, i + 3)) && !/\w/.test(text[i - 1] ?? '')) {
      const hashes = text.slice(i + 1).match(/^#*/)[0];
      const close = `"${hashes}`;
      const end = text.indexOf(close, i + 2 + hashes.length);
      const stop = end === -1 ? text.length : end + close.length;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Rust functions whose body has more than `max` non-blank lines, as `name:line`. */
export function longRustFunctions(text, max = MAX_LINES) {
  const code = blankStringsAndComments(text);
  const long = [];
  const fnHead = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = fnHead.exec(code)) !== null) {
    let i = match.index;
    // The body: the first `{` before a `;` (a declaration has none).
    while (i < code.length && code[i] !== '{' && code[i] !== ';') i++;
    if (code[i] !== '{') continue;
    const start = i;
    let depth = 0;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) break;
    }
    const lines = code
      .slice(start, i)
      .split('\n')
      .filter((l) => l.trim() !== '').length;
    if (lines > max) long.push(`${match[1]}:${code.slice(0, match.index).split('\n').length}`);
  }
  return long;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/** The counts, per kind. */
export async function measure(root) {
  const uiDir = path.join(root, 'packages/tmuxy-ui');
  const { ESLint } = await import(path.join(uiDir, 'node_modules/eslint/lib/api.js')).catch(
    () => import('eslint'),
  );
  const eslint = new ESLint({
    cwd: uiDir,
    overrideConfig: {
      rules: {
        complexity: ['warn', { max: MAX_BRANCHES }],
        'max-lines-per-function': [
          'warn',
          { max: MAX_LINES, skipBlankLines: true, skipComments: true },
        ],
      },
    },
  });
  const results = await eslint.lintFiles(['src']);
  let typescriptBranchy = 0;
  let typescriptLong = 0;
  for (const result of results) {
    if (SKIP.test(result.filePath)) continue;
    for (const message of result.messages) {
      if (message.ruleId === 'complexity') typescriptBranchy++;
      if (message.ruleId === 'max-lines-per-function') typescriptLong++;
    }
  }

  let rustLong = 0;
  for (const file of trackedFiles(root)) {
    if (
      !file.endsWith('.rs') ||
      !file.startsWith('packages/') ||
      file.startsWith('packages/vt100/')
    )
      continue;
    if (RUST_SKIP.test(file)) continue;
    const full = path.join(root, file);
    if (fs.existsSync(full)) rustLong += longRustFunctions(fs.readFileSync(full, 'utf8')).length;
  }
  return { typescriptBranchy, typescriptLong, rustLong };
}

/** The lint gate's `complexity` step: no count above or below its ratchet. */
export async function checkComplexity(root) {
  const ratchets = JSON.parse(fs.readFileSync(path.join(root, 'bin/ci/ratchets.json'), 'utf8'));
  const now = await measure(root);
  const errors = [];
  const what = {
    typescriptBranchy: `TypeScript functions with more than ${MAX_BRANCHES} paths`,
    typescriptLong: `TypeScript functions longer than ${MAX_LINES} lines`,
    rustLong: `Rust functions longer than ${MAX_LINES} lines`,
  };
  for (const [kind, count] of Object.entries(now)) {
    const limit = ratchets.complexity[kind];
    if (count > limit) {
      errors.push(
        `[complexity] ${count} ${what[kind]}, over the ${limit} allowed (bin/ci/ratchets.json): split the one this change grew.`,
      );
    } else if (count < limit) {
      errors.push(
        `[complexity] ${what[kind]} are down to ${count} from ${limit}: lower complexity.${kind} in bin/ci/ratchets.json (node bin/ci/complexity.mjs --update), so it stays down.`,
      );
    }
  }
  return { now, errors };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  if (process.argv.includes('--update')) {
    const file = path.join(root, 'bin/ci/ratchets.json');
    const ratchets = JSON.parse(fs.readFileSync(file, 'utf8'));
    ratchets.complexity = await measure(root);
    fs.writeFileSync(file, `${JSON.stringify(ratchets, null, 2)}\n`);
    console.log(JSON.stringify(ratchets.complexity));
  } else {
    const { now, errors } = await checkComplexity(root);
    console.log(JSON.stringify(now));
    for (const error of errors) console.error(error);
    if (errors.length) process.exit(1);
  }
}
