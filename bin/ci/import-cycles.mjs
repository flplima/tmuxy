import fs from 'node:fs';
import path from 'node:path';

/**
 * Import cycles in the UI's source: two modules that import each other,
 * directly or round a loop, are one module in two files, and the loop is
 * where a change in one quietly reaches the other. The layer rule
 * (eslint.config.js) stops an import going up a layer; this stops a loop
 * inside one.
 *
 * The graph is the relative imports of `packages/tmuxy-ui/src`, type-only ones
 * included: they do not run, but they tie the two modules' shapes together
 * the same. Tests and stories are left out. A loop is a strongly connected
 * set of two or more modules (Tarjan), reported as its members.
 */

const SRC = 'packages/tmuxy-ui/src';
const EXTS = ['.ts', '.tsx'];
const SKIP = /(__tests__|\.test\.|\.stories\.|\/stories\/|\/test\/)/;
const IMPORT =
  /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;

function sourceFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (EXTS.includes(path.extname(entry.name)) && !SKIP.test(full)) acc.push(full);
  }
  return acc;
}

/** The file an import names, if it is one of `known`. */
function resolve(from, spec, known) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, ...EXTS.map((e) => base + e)]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Module → the modules it imports, from each file's text. */
export function importGraph(files, read) {
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const edges = new Set();
    for (const match of read(file).matchAll(IMPORT)) {
      const target = resolve(file, match[1] ?? match[2], known);
      if (target && target !== file) edges.add(target);
    }
    graph.set(file, [...edges]);
  }
  return graph;
}

/** The strongly connected sets of two or more modules: the cycles. */
export function cycles(graph) {
  let index = 0;
  const stack = [];
  const meta = new Map();
  const found = [];
  const visit = (node) => {
    meta.set(node, { index, low: index, onStack: true });
    index++;
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!meta.has(next)) {
        visit(next);
        meta.get(node).low = Math.min(meta.get(node).low, meta.get(next).low);
      } else if (meta.get(next).onStack) {
        meta.get(node).low = Math.min(meta.get(node).low, meta.get(next).index);
      }
    }
    if (meta.get(node).low === meta.get(node).index) {
      const set = [];
      let member;
      do {
        member = stack.pop();
        meta.get(member).onStack = false;
        set.push(member);
      } while (member !== node);
      if (set.length > 1) found.push(set.sort());
    }
  };
  for (const node of graph.keys()) if (!meta.has(node)) visit(node);
  return found;
}

/** The policy check (bin/ci/policy.mjs): no cycle at all. */
export function checkImportCycles(root, addError) {
  const files = sourceFiles(path.join(root, SRC));
  const graph = importGraph(files, (f) => fs.readFileSync(f, 'utf8'));
  for (const set of cycles(graph)) {
    const names = set.map((f) => path.relative(path.join(root, SRC), f));
    addError(
      `[cycles] ${names.length} modules of ${SRC} import each other round a loop: ${names.join(', ')}. Move what they share into a module both import, or one into the other.`,
    );
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const errors = [];
  checkImportCycles(root, (e) => errors.push(e));
  console.log(errors.join('\n\n') || 'no cycles');
}
