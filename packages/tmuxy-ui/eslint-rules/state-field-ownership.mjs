/**
 * tmuxy/state-field-ownership
 *
 * Enforces the state-slice ownership invariant: a file under
 * `src/machines/app/states/<name>.ts` or `src/machines/app/actions/<name>.ts`
 * may only `assign(...)` fields whose FIELD_OWNERS entry is `<name>`.
 *
 * The map is read from src/machines/app/context.ts, its one source of truth
 * (whose `satisfies` clause keeps it covering every context field).
 */

import { readFileSync } from 'node:fs';

const CONTEXT_PATH = new URL('../src/machines/app/context.ts', import.meta.url);

function loadFieldOwners() {
  const source = readFileSync(CONTEXT_PATH, 'utf8');
  const block = source.match(/export const FIELD_OWNERS = \{([\s\S]*?)\} as const satisfies/);
  if (!block) {
    throw new Error(`tmuxy/state-field-ownership: no FIELD_OWNERS block in ${CONTEXT_PATH}`);
  }
  const owners = {};
  for (const [, field, owner] of block[1].matchAll(/^\s*(\w+): '(\w+)',$/gm)) {
    owners[field] = owner;
  }
  if (Object.keys(owners).length === 0) {
    throw new Error(`tmuxy/state-field-ownership: FIELD_OWNERS in ${CONTEXT_PATH} parsed empty`);
  }
  return owners;
}

const FIELD_OWNERS = loadFieldOwners();

const STATE_FILE_REGEX = /\/machines\/app\/(?:states|actions)\/([a-zA-Z0-9_-]+)\.ts$/;

/**
 * Walk an arbitrary AST node looking for ObjectExpression children and
 * collect their plain Identifier property keys. Used because assign() can be
 * called as either `assign({ foo: 1 })` or `assign(() => ({ foo: 1 }))`,
 * and we want to catch foreign-field assigns either way.
 *
 * We intentionally do not recurse into nested ObjectExpressions whose parent
 * is itself an inner value (e.g. nested partial state) — only direct keys
 * on the outermost assign payload count. To approximate that without full
 * type-aware analysis, we treat the first ObjectExpression encountered while
 * walking from the assign() argument as the payload object.
 */
function findAssignPayloadKeys(arg) {
  if (!arg) return [];

  if (arg.type === 'ObjectExpression') {
    return collectKeysFromObject(arg);
  }

  if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
    // Single-expression arrow: body is the returned object directly.
    if (arg.body.type === 'ObjectExpression') {
      return collectKeysFromObject(arg.body);
    }
    // Block body: walk top-level return statements.
    if (arg.body.type === 'BlockStatement') {
      const keys = [];
      for (const stmt of arg.body.body) {
        if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'ObjectExpression') {
          keys.push(...collectKeysFromObject(stmt.argument));
        }
      }
      return keys;
    }
  }

  return [];
}

function collectKeysFromObject(objectExpr) {
  const out = [];
  for (const prop of objectExpr.properties) {
    if (prop.type !== 'Property') continue;
    if (prop.computed) continue;
    if (prop.key.type === 'Identifier') {
      out.push({ name: prop.key.name, node: prop.key });
    } else if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') {
      out.push({ name: prop.key.value, node: prop.key });
    }
  }
  return out;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce state-slice field ownership: state files may only assign to fields they own.',
    },
    schema: [],
    messages: {
      foreignField:
        'Field "{{field}}" is owned by state slice "{{owner}}", but this file owns "{{current}}". Move this assign to states/{{owner}}.ts (or actions/{{owner}}.ts) or send an event to that state.',
      parentField:
        'Field "{{field}}" is parent-owned (lifecycle/connection/dimensions). State files cannot mutate parent fields directly; emit an event the parent listens to instead.',
      unknownField:
        'Field "{{field}}" is not in FIELD_OWNERS. Either it is a typo or the registry in src/machines/app/context.ts is out of date.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? '';
    const match = filename.replace(/\\/g, '/').match(STATE_FILE_REGEX);
    if (!match) return {};
    const currentState = match[1];

    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'assign') return;
        if (node.arguments.length === 0) return;
        const keys = findAssignPayloadKeys(node.arguments[0]);

        // Escape hatch: a `cross-cutting:` comment before or inside the
        // `assign(...)` call lets a handler legitimately write a field owned
        // by another slice.
        const sourceCode = context.sourceCode ?? context.getSourceCode?.();
        const comments = sourceCode?.getCommentsInside?.(node) ?? [];
        const beforeComments = sourceCode?.getCommentsBefore?.(node) ?? [];
        const isCrossCutting = [...comments, ...beforeComments].some((c) =>
          /cross-cutting:/i.test(c.value),
        );

        for (const { name, node: keyNode } of keys) {
          if (!(name in FIELD_OWNERS)) {
            context.report({
              node: keyNode,
              messageId: 'unknownField',
              data: { field: name },
            });
            continue;
          }
          const owner = FIELD_OWNERS[name];
          if (owner === currentState) continue;
          if (isCrossCutting) continue;
          if (owner === 'parent') {
            context.report({
              node: keyNode,
              messageId: 'parentField',
              data: { field: name },
            });
          } else {
            context.report({
              node: keyNode,
              messageId: 'foreignField',
              data: { field: name, owner, current: currentState },
            });
          }
        }
      },
    };
  },
};
