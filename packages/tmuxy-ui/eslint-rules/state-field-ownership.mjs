/**
 * tmuxy/state-field-ownership
 *
 * Enforces the state-slice ownership invariant: a file under
 * `src/machines/app/states/<name>.ts` or `src/machines/app/actions/<name>.ts`
 * (or a helper in `actions/<name>/`) may only `assign(...)` fields whose
 * FIELD_OWNERS entry is `<name>`, and any
 * other file in `src/machines/app/` (the machine's own wiring, the command
 * entry, the model-update mirror) owns no field at all.
 * `assignCtx(...)` (src/machines/app/actionTypes.ts) is `assign` bound to the
 * machine's types, and is read the same way.
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

const SLICE_FILE_REGEX =
  /\/machines\/app\/(?:states|actions)\/([a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_-]+)?\.ts$/;
const APP_FILE_REGEX = /\/machines\/app\/[a-zA-Z0-9_-]+\.ts$/;

/** The callees whose first argument is a context payload. */
const ASSIGN_CALLEES = new Set(['assign', 'assignCtx']);

/**
 * The top-level keys of an assign payload: `assign({ foo: 1 })`,
 * `assign(() => ({ foo: 1 }))`, or the objects a function body returns.
 * Nested objects are values, not fields.
 */
function findAssignPayloadKeys(arg) {
  if (!arg) return [];

  if (arg.type === 'ObjectExpression') {
    return collectKeysFromObject(arg);
  }

  if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
    if (arg.body.type === 'ObjectExpression') {
      return collectKeysFromObject(arg.body);
    }
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
      unownedFile:
        'Field "{{field}}" is owned by state slice "{{owner}}", and this file owns no field. Move this assign to actions/{{owner}}.ts, or mark it `// cross-cutting: <reason>`.',
      unknownField:
        'Field "{{field}}" is not in FIELD_OWNERS. Either it is a typo or the registry in src/machines/app/context.ts is out of date.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? '';
    const path = filename.replace(/\\/g, '/');
    const match = path.match(SLICE_FILE_REGEX);
    if (!match && !APP_FILE_REGEX.test(path)) return {};
    const currentState = match ? match[1] : null;

    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || !ASSIGN_CALLEES.has(node.callee.name)) return;
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
          if (currentState === null) {
            context.report({
              node: keyNode,
              messageId: 'unownedFile',
              data: { field: name, owner },
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
