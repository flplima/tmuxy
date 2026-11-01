import { execFileSync } from 'node:child_process';

/**
 * A hard cap of 5,000 tokens (bytes / 4) on every file in the index — what a
 * commit would contain, so the pre-commit hook and CI judge the same bytes. An
 * agent reads a file whole; past this size it pays for a file before reading
 * any of the code that matters to it.
 *
 * Exempt: lockfiles, generated and binary files (nobody authors them), and
 * GitHub workflows, whose jobs must share one file to depend on each other.
 */
const MAX_FILE_TOKENS = 5000;
const BYTES_PER_TOKEN = 4;
const MAX_FILE_BYTES = MAX_FILE_TOKENS * BYTES_PER_TOKEN;

const TOKEN_LIMIT_IGNORE = [
  /^package-lock\.json$/,
  /^Cargo\.lock$/,
  /(?:^|\/)gen\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)pkg\//,
  /^packages\/vt100\//,
  /^\.github\/workflows\//,
  /\.(?:woff2?|ttf|otf|png|jpg|jpeg|gif|ico|icns|webp|pdf|wasm|svg)$/i,
];

function splitGuidanceFor(relPath) {
  if (relPath.endsWith('.stories.tsx')) {
    return (
      '  How to split a Storybook file:\n' +
      '  1. Group stories by feature/interaction into smaller `*.stories.tsx` files.\n' +
      '  2. Drop low-value visual-only or duplicate permutation stories that do not assert behavior via `play`.\n' +
      '  3. Move shared story fixtures/helpers to a dedicated helper module (no barrel re-exports).'
    );
  }
  if (relPath.startsWith('packages/tmuxy-ui/src/')) {
    return (
      '  How to split a tmuxy-ui source file:\n' +
      '  1. Extract cohesive sub-components, custom hooks, pure domain helpers, or child actors into sibling files.\n' +
      '  2. Import directly from concrete module files — `tmuxy/no-barrel-files` forbids `index.ts` and re-export barrels.\n' +
      '  3. For XState machines, extract action/guard builders or child actors into sibling modules under the same feature directory.'
    );
  }
  if (relPath.endsWith('.rs')) {
    return (
      '  How to split a Rust file:\n' +
      '  1. Extract cohesive domain submodules (`mod <subname>;`) under the parent module directory.\n' +
      '  2. Move inline `#[cfg(test)] mod tests` blocks into a sibling `tests.rs` submodule or integration tests under `tests/`.\n' +
      '  3. Separate types/protocol definitions, state transitions, and I/O transport handlers into distinct modules.'
    );
  }
  if (relPath.startsWith('tests/') || relPath.includes('.test.')) {
    return (
      '  How to split a test file:\n' +
      '  1. Split suites by user-visible feature workflow (`<feature>.test.js` / `<module>.<aspect>.test.ts`).\n' +
      '  2. Extract shared setup and assertion helpers into `tests/helpers/`.\n' +
      '  3. Consolidate redundant tests that cover the same user path (one feature, one end-to-end test).'
    );
  }
  if (relPath.endsWith('.md')) {
    return (
      '  How to split a doc:\n' +
      '  1. Move whole sections into a companion named after the parent (`TMUX-TAGS.md`), leaving a one-line pointer.\n' +
      '  2. Keep tables unpadded (`| a | b |`) — column padding can be half of a doc.\n' +
      '  3. Fix `#anchor` links that pointed at a moved section.'
    );
  }
  return (
    '  How to split this file:\n' +
    '  1. Break the file into smaller, single-responsibility modules or topic files under 5,000 tokens (20,000 bytes).\n' +
    '  2. Reference extracted modules directly rather than creating barrel files.'
  );
}

/** Every path in the index with the size of its indexed blob, in two git calls. */
function indexedFileSizes(root) {
  const git = (args, input) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  const entries = git(['ls-files', '-s', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, relPath] = line.split('\t');
      return { relPath, sha: meta.split(' ')[1] };
    });
  const sizes = git(
    ['cat-file', '--batch-check=%(objectsize)'],
    entries.map((e) => e.sha).join('\n') + '\n',
  )
    .trim()
    .split('\n')
    .map(Number);
  return entries.map((e, i) => ({ relPath: e.relPath, bytes: sizes[i] }));
}

export function checkFileTokenLimit(root, addError) {
  for (const { relPath, bytes } of indexedFileSizes(root)) {
    if (TOKEN_LIMIT_IGNORE.some((re) => re.test(relPath))) continue;
    const tokens = Math.ceil(bytes / BYTES_PER_TOKEN);
    if (tokens > MAX_FILE_TOKENS) {
      addError(
        `[file-size] ${relPath} is ${tokens.toLocaleString()} tokens (${bytes.toLocaleString()} bytes), exceeding the ${MAX_FILE_TOKENS.toLocaleString()}-token (${MAX_FILE_BYTES.toLocaleString()}-byte) hard cap (tokens = bytes / 4).\n` +
          splitGuidanceFor(relPath),
      );
    }
  }
}
