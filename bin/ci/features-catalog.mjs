import fs from 'node:fs';
import path from 'node:path';

/**
 * docs/FEATURES*.md catalogs what a user or an agent can do, one row per
 * capability, with a column per surface. This holds the catalog and the code
 * to each other, in both directions:
 *
 *   - every menu item id, default tmux key binding, CLI verb and user option
 *     the code has appears in its column of some row (a surface that gains an
 *     action without a row fails);
 *   - every menu id, binding, CLI verb and option a row names still exists (a
 *     surface that loses one fails).
 *
 * It reads code and docs only. `Enforced by` cells are checked by
 * invariant-enforcers.mjs, which reads FEATURES*.md as it reads INVARIANTS*.md.
 */

const MENU_SOURCES = [
  'packages/tmuxy-ui/src/components/menus/specs',
  'packages/tmuxy-ui/src/components/widgets/preview/definition.ts',
];
const DEFAULTS_CONF = 'packages/tmuxy-core/assets/tmuxy.defaults.conf';
const CLI_DISPATCH = 'packages/tmuxy-cli/bin/tmuxy-cli';
const CLI_SCRIPTS = 'packages/tmuxy-cli/bin/tmuxy';
const VERBS = 'packages/tmuxy-verbs/src';
const CONSTANTS = 'packages/tmuxy-core/src/constants.rs';

const COLUMNS = { menu: 'Menu', keys: 'Keybinding', cli: 'CLI', config: 'Config / Tag' };

function filesUnder(root, rel, pattern) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [rel];
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => path.join(rel, e.name));
}

/** Menu item ids, and `prefix*` for the ids built at run time. */
export function menuIds(sources) {
  const ids = new Set();
  for (const text of sources) {
    for (const [, id] of text.matchAll(/\bid: '([^']+)'/g)) ids.add(id);
    for (const [, id] of text.matchAll(/^\s+'([a-z][a-z-]+)': TmuxOp\./gm)) ids.add(id);
    for (const [, prefix] of text.matchAll(/\bid: `([a-z][a-z:-]*)\$\{/g)) ids.add(`${prefix}*`);
  }
  return ids;
}

/** `<table> <key>` for each default binding: `prefix -`, `root C-h`, `pane x`. */
export function bindings(conf) {
  const found = new Set();
  for (const line of conf.split('\n')) {
    const words = line.trim().match(/^bind(?:-key)?\s+(.*)$/);
    if (!words) continue;
    const args = words[1].match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    let table = 'prefix';
    let i = 0;
    for (; i < args.length; i++) {
      if (args[i] === '-n') table = 'root';
      else if (args[i] === '-T') table = args[++i];
      else if (args[i] === '-r') continue;
      else break;
    }
    let key = args[i];
    if (!key) continue;
    if (/^'.*'$|^".*"$/.test(key)) key = key.slice(1, -1);
    if (key === '\\\\') key = '\\';
    found.add(`${table} ${key}`);
  }
  return found;
}

/** `tmuxy <noun> <verb>` the shell CLI dispatches, or `tmuxy <noun>` for a noun with no verbs of its own. */
export function cliCommands(dispatch, scripts) {
  const commands = new Set();
  const nouns = new Set();
  const main = dispatch.slice(dispatch.indexOf('case "${1:-}" in'));
  for (const [, labels] of main.matchAll(/^ {2}([a-z][a-z|-]*)\)$/gm)) {
    for (const noun of labels.split('|')) nouns.add(noun);
  }
  const withVerbs = new Set();
  for (const text of scripts) {
    let noun = null;
    for (const line of text.split('\n')) {
      const fn = line.match(/^cmd_([a-z_]+)\(\)/);
      if (fn) noun = fn[1].replace(/_/g, '-');
      const verb = line.match(/^ {4}([a-z][a-z|-]*)\)$/);
      if (noun && nouns.has(noun) && verb) {
        withVerbs.add(noun);
        for (const v of verb[1].split('|')) commands.add(`tmuxy ${noun} ${v}`);
      }
    }
  }
  // A noun with verbs is named by them; one without, by itself.
  for (const noun of nouns) if (!withVerbs.has(noun)) commands.add(`tmuxy ${noun}`);
  return { commands, nouns };
}

/** Kebab-cased clap variants the Rust verbs define: verbs the shell hands on. */
export function rustVerbs(sources) {
  const verbs = new Set();
  for (const text of sources) {
    for (const [, name] of text.matchAll(/^ {4}([A-Z][A-Za-z]+)(?: \{|\(|,|$)/gm)) {
      verbs.add(name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
    }
  }
  return verbs;
}

/** The user options the defaults set, and every option tmuxy knows. */
export function options(conf, constants) {
  const user = new Set(
    [...conf.matchAll(/^set(?:-option)? -g (@tmuxy-[a-z-]+)/gm)].map((m) => m[1]),
  );
  const known = new Set([...constants.matchAll(/"(@tmuxy-[a-z-]+)"/g)].map((m) => m[1]));
  for (const option of user) known.add(option);
  return { user, known };
}

/** Each catalog row's tokens, by column: `{doc, line, cells: {menu: [...], ...}}`. */
export function catalogRows(docs) {
  const rows = [];
  for (const [doc, text] of docs) {
    let columns = null;
    text.split('\n').forEach((line, index) => {
      if (!line.startsWith('|')) {
        columns = null;
        return;
      }
      // A cell may hold an escaped pipe (`prefix \|`): split only on bare ones.
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map((c) => c.replace(/\\\|/g, '|').trim());
      if (cells.includes(COLUMNS.cli) && cells.includes(COLUMNS.menu)) {
        columns = Object.fromEntries(
          Object.entries(COLUMNS).map(([k, title]) => [k, cells.indexOf(title)]),
        );
        return;
      }
      if (!columns || /^-+$/.test(cells[0].replace(/[: ]/g, ''))) return;
      const tokens = Object.fromEntries(
        Object.entries(columns).map(([k, at]) => [
          k,
          [...(cells[at] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]),
        ]),
      );
      rows.push({ doc, line: index + 1, id: cells[0], tokens });
    });
  }
  return rows;
}

export function checkFeaturesCatalog(root, addError) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const docs = fs
    .readdirSync(path.join(root, 'docs'))
    .filter((f) => /^FEATURES.*\.md$/.test(f))
    .map((f) => [`docs/${f}`, read(`docs/${f}`)]);
  if (docs.length === 0) return;
  const rows = catalogRows(docs);
  const named = (column) => new Set(rows.flatMap((r) => r.tokens[column]));

  const menu = menuIds(
    MENU_SOURCES.flatMap((rel) => filesUnder(root, rel, /\.ts$/))
      .filter((f) => !f.includes('__tests__'))
      .map(read),
  );
  const conf = read(DEFAULTS_CONF);
  const keys = bindings(conf);
  const { commands, nouns } = cliCommands(
    read(CLI_DISPATCH),
    filesUnder(root, CLI_SCRIPTS, /^cli-.*\.sh$/).map(read),
  );
  const rust = rustVerbs(filesUnder(root, VERBS, /\.rs$/).map(read));
  const { user, known } = options(conf, read(CONSTANTS));

  const missing = (what, have, column, hint) => {
    const listed = named(column);
    const gone = [...have].filter((item) => !listed.has(item));
    if (gone.length)
      addError(
        `[features] ${gone.length} ${what} with no row in docs/FEATURES*.md: ${gone.join(', ')}. ` +
          `Add each to the ${COLUMNS[column]} column of the row for its capability (${hint}).`,
      );
  };
  missing('menu item(s)', menu, 'menu', 'the item id; `prefix*` for one built at run time');
  missing('default key binding(s)', keys, 'keys', '`<table> <key>`, as `prefix -` or `pane x`');
  missing('CLI command(s)', commands, 'cli', '`tmuxy <noun> <verb>`');
  missing('user option(s)', user, 'config', 'the `@tmuxy-*` option');

  for (const row of rows) {
    const stale = [
      ...row.tokens.menu.filter((t) => !menu.has(t)).map((t) => `menu \`${t}\``),
      ...row.tokens.keys
        .filter((t) => /^(prefix|root|pane|tab|copy-mode(-vi)?) /.test(t) && !keys.has(t))
        .map((t) => `binding \`${t}\``),
      ...row.tokens.cli
        .filter((t) => t.startsWith('tmuxy '))
        .filter((t) => {
          const [, noun, verb] = t.split(/\s+/);
          if (!nouns.has(noun)) return true;
          if (!verb || verb.startsWith('-') || verb.startsWith('<') || verb.startsWith('['))
            return false;
          return !commands.has(`tmuxy ${noun} ${verb}`) && !rust.has(verb);
        })
        .map((t) => `CLI \`${t}\``),
      ...row.tokens.config
        .filter((t) => t.startsWith('@tmuxy-') && !t.endsWith('*') && !known.has(t))
        .map((t) => `option \`${t}\``),
    ];
    if (stale.length)
      addError(
        `[features] ${row.doc}:${row.line} ${row.id} names ${stale.join(', ')}, which the code no ` +
          'longer has. Fix the row, or drop it with the capability.',
      );
  }
}
