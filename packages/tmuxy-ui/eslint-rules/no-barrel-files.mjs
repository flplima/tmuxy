/**
 * tmuxy/no-barrel-files
 *
 * Enforces the zero-barrel rule across `src/`:
 * 1. No `index.ts` or `index.tsx` files — every module has a descriptive file
 *    name so imports always name the leaf module directly.
 * 2. No re-export declarations (`export * from '...'` or `export { ... } from '...'`),
 *    and no `import { x } from '...'; export { x };` passthroughs from TS/JS
 *    modules (excluding `src/lib.ts`, the package root entry point).
 */

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid barrel files (index.ts/tsx) and re-export shims so every symbol has one canonical import path',
    },
    schema: [],
    messages: {
      noIndexFile:
        'Barrel index files ({{basename}}) are forbidden. Give this module a descriptive file name and import it directly.',
      noExportAll:
        "Re-exporting via `export * from '{{source}}'` is forbidden. Import symbols directly from their source module.",
      noReExportNamed:
        "Re-exporting from '{{source}}' is forbidden. Import symbols directly from their source module.",
      noPassthroughExport:
        "Re-exporting imported binding '{{name}}' (from '{{source}}') is forbidden. Import '{{name}}' directly from '{{source}}'.",
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? '').replaceAll('\\', '/');
    if (!filename.includes('/src/')) return {};

    // `src/lib.ts` is the package.json root entry point (`"exports": { ".": "./src/lib.ts" }`).
    if (filename.endsWith('/src/lib.ts')) return {};

    const basename = filename.slice(filename.lastIndexOf('/') + 1);
    const isIndexFile = /^index\.tsx?$/.test(basename);

    /** Map of local identifier name -> import source for non-asset imports */
    const importedBindings = new Map();

    return {
      Program(node) {
        if (isIndexFile) {
          context.report({
            node,
            messageId: 'noIndexFile',
            data: { basename },
          });
        }
      },
      ImportDeclaration(node) {
        const source = node.source?.value;
        if (typeof source !== 'string' || source.endsWith('.json')) return;
        for (const spec of node.specifiers ?? []) {
          if (spec.local?.name) {
            importedBindings.set(spec.local.name, source);
          }
        }
      },
      ExportAllDeclaration(node) {
        context.report({
          node,
          messageId: 'noExportAll',
          data: { source: String(node.source?.value ?? '') },
        });
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          context.report({
            node,
            messageId: 'noReExportNamed',
            data: { source: String(node.source.value ?? '') },
          });
          return;
        }
        if (node.declaration) return;
        for (const spec of node.specifiers ?? []) {
          const localName = spec.local?.name;
          if (localName && importedBindings.has(localName)) {
            context.report({
              node: spec,
              messageId: 'noPassthroughExport',
              data: {
                name: localName,
                source: importedBindings.get(localName),
              },
            });
          }
        }
      },
    };
  },
};
