/**
 * Fixtures a Storybook story and an E2E helper share, so the two layers
 * cannot drift: the module lives under packages/tmuxy-ui/src/stories in
 * erasable TypeScript and is loaded here through Node's own loader (Jest's
 * `require` cannot load an ES module and the suite has no transform;
 * `process.getBuiltinModule` hands back the real `module` builtin, and Node
 * strips the types itself).
 */

const { resolve } = require('node:path');

const { createRequire } = process.getBuiltinModule('module');

/** The shared module `file` (`keyboardMock.ts`, `cellGridHelpers.ts`, …). */
function storyModule(file) {
  return createRequire(__filename)(resolve(__dirname, '../../packages/tmuxy-ui/src/stories', file));
}

/**
 * A page expression calling `fn` with `args` (JSON values) followed by the
 * `shared` functions, passed by their source: a shared function has to be
 * self-contained, since it is rebuilt in the page from its text.
 */
function inPage(fn, args, shared = []) {
  const params = [...args.map((a) => JSON.stringify(a)), ...shared.map(String)];
  return `(${fn})(${params.join(', ')})`;
}

module.exports = { storyModule, inPage };
