#!/usr/bin/env node
// docs/CLI.md (and its CLI-<noun>.md companions) is every `tmuxy` command and
// flag, generated from the CLI's own `--help`, so the docs cannot drift from
// the binary:
//
//   node bin/ci/cli-reference.mjs           rewrite the docs
//   node bin/ci/cli-reference.mjs --check   fail when a committed doc differs
//
// The commands are found from the help itself: `tmuxy --help`, then the
// `Commands:` / `Settings:` block of each help, down the tree. Some commands'
// help is the server binary's (clap), so the generator needs one built; it
// fails, writing nothing, when it cannot find it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = 'packages/tmuxy-cli/bin/tmuxy-cli';
const DOCS = 'docs';
export const REGENERATE = 'node bin/ci/cli-reference.mjs';
export const MAX_DOC_BYTES = 20000;

// A section bigger than this goes to a companion doc, `CLI-<command>.md`.
const COMPANION_BYTES = 2500;
const MAX_DEPTH = 3;

// Words in a Commands block that are not commands to document, with why.
const SKIP = new Map([['help', 'clap lists its own help subcommand; `--help` is the same text']]);

// Commands whose subcommands are not documented one by one, with why.
const FLAT = new Map([
  [
    'server',
    "its subcommands are the server binary's verbs, which the commands above run (trace, keymap, session, agent, plugin, config); its own help lists them",
  ],
]);

const BLOCK = /^(Commands|Subcommands|Settings):\s*$/;

/**
 * The names a help text lists under its blocks, in order: `commands` (each has
 * a help of its own) and `settings` (`tmuxy config <setting>`: arguments the
 * parent's help explains, which `--help` would run, not describe).
 */
export function parseHelp(help) {
  const found = { commands: [], settings: [] };
  let names = null;
  for (const line of help.split('\n')) {
    const header = line.match(BLOCK);
    if (header) {
      names = header[1] === 'Settings' ? found.settings : found.commands;
      continue;
    }
    const inBlock = names !== null;
    if (!inBlock) continue;
    if (line.trim() === '') {
      names = null;
      continue;
    }
    const entry = line.match(/^ {2}([A-Za-z][\w-]*)(?:\s|$)/);
    if (entry) {
      if (!names.includes(entry[1])) names.push(entry[1]);
    } else if (!/^ {3,}/.test(line)) {
      names = null;
    }
  }
  found.commands = found.commands.filter((n) => !SKIP.has(n));
  return found;
}

/** The top help names its version on line one; the doc must not change per release. */
export function stripVersion(help) {
  return help.replace(/^tmuxy \d[^\s]* — /, 'tmuxy — ');
}

function tidy(help) {
  return stripVersion(help)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** One tree node per command: { path: ['pane','list'], help, children }. */
export function walk(run, argv = [], depth = 0, parentHelp = null) {
  const help = tidy(run([...argv, '--help']));
  if (parentHelp !== null && help === parentHelp) return null;
  const node = { path: argv, help, children: [] };
  if (depth >= MAX_DEPTH || (depth === 1 && FLAT.has(argv[0]))) return node;
  for (const name of parseHelp(help).commands) {
    const child = walk(run, [...argv, name], depth + 1, help);
    if (child) node.children.push(child);
  }
  return node;
}

function* nodes(node) {
  yield node;
  for (const c of node.children) yield* nodes(c);
}

const title = (p) => ['tmuxy', ...p].join(' ');
const block = (help) => '```text\n' + help + '\n```\n';

function section(node) {
  const level = '#'.repeat(Math.min(node.path.length + 1, 4));
  return `${level} \`${title(node.path)}\`\n\n${block(node.help)}`;
}

function sectionText(node) {
  return [...nodes(node)].map(section).join('\n');
}

const HEADER = `# CLI reference

Every \`tmuxy\` command and flag, in the order \`tmuxy --help\` lists them. This
file is generated from each command's own \`--help\`, so it cannot drift from
the CLI, and each help is shown verbatim in a \`text\` block: it is CLI output,
not code from the codebase. Do not edit it by hand: change the help text, then
run \`${REGENERATE}\` (\`npm run check:policy\` fails when this
doc differs from the help).

[FEATURES.md](FEATURES.md) is the catalog of what a user or an agent can do,
with the test that holds each capability; this is where each verb's flags are.
Commands whose help is long are in their own doc, linked below.
`;

/** The one-line description the top help gives a command. */
export function summary(topHelp, name) {
  const line = topHelp.split('\n').find((l) => l.startsWith(`  ${name} `));
  return line ? line.trim().slice(name.length).trim() : `The \`tmuxy ${name}\` command.`;
}

/** The docs, as a Map of file name (under docs/) to text, from the help tree. */
export function render(tree) {
  const files = new Map();
  const top = tree.children;
  const main = [HEADER, `## \`tmuxy\`\n\n${block(tree.help)}`];
  for (const cmd of top) {
    const text = sectionText(cmd);
    if (Buffer.byteLength(text) <= COMPANION_BYTES) {
      main.push(text);
      continue;
    }
    const name = `CLI-${cmd.path[0].toUpperCase()}.md`;
    files.set(
      name,
      `# \`tmuxy ${cmd.path[0]}\` reference\n\nGenerated from \`--help\` by \`${REGENERATE}\`; the other commands are in [CLI.md](CLI.md).\n\n${text}`,
    );
    main.push(
      `## \`tmuxy ${cmd.path[0]}\`\n\n${summary(tree.help, cmd.path[0])}\n\nIts subcommands and flags are in [${name}](${name}).\n`,
    );
  }
  files.set('CLI.md', main.join('\n'));
  for (const [name, text] of files) {
    const bytes = Buffer.byteLength(text);
    if (bytes >= MAX_DOC_BYTES) {
      throw new Error(`docs/${name} would be ${bytes} bytes; a doc stays under ${MAX_DOC_BYTES}`);
    }
  }
  return files;
}

/** Split a generated doc into `title -> body`, by its headings. */
export function sections(text) {
  const out = new Map();
  let key = '(header)';
  let body = [];
  for (const line of text.split('\n')) {
    const h = line.match(/^#{2,4} `([^`]+)`$/);
    if (h) {
      out.set(key, body.join('\n'));
      key = h[1];
      body = [];
    } else {
      body.push(line);
    }
  }
  out.set(key, body.join('\n'));
  return out;
}

/** Names of the commands whose section differs between two sets of docs. */
export function changedCommands(committed, fresh) {
  const flat = (files) => {
    const m = new Map();
    for (const text of files.values()) {
      for (const [k, v] of sections(text)) m.set(k, (m.get(k) ?? '') + v);
    }
    return m;
  };
  const a = flat(committed);
  const b = flat(fresh);
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].filter((n) => a.get(n) !== b.get(n) && n !== '(header)');
}

export function findServer() {
  const targets = [process.env.CARGO_TARGET_DIR, path.join(ROOT, 'target')].filter(Boolean);
  const candidates = [process.env.TMUXY_CLI_DOC_SERVER];
  for (const t of targets)
    for (const p of ['debug', 'release']) candidates.push(path.join(t, p, 'tmuxy-server'));
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) {
    throw new Error(
      'tmuxy-server is not built: the help of `server`, `trace`, `keymap` and `session save|restore|…` is its own.\n' +
        'Run `cargo build -p tmuxy-server` (it looks in $CARGO_TARGET_DIR and target/), or set TMUXY_CLI_DOC_SERVER to the binary.',
    );
  }
  return found;
}

/** A runner that returns a command's help, with no tmux server and nothing of the user's in reach. */
export function makeRunner(server) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-clidoc-'));
  const env = { ...process.env };
  for (const k of ['TMUX', 'TMUX_PANE', 'TMUX_BIN', 'TMUXY_SERVER_SUBCOMMAND', 'TMUXY_PASSWORD'])
    delete env[k];
  for (const k of Object.keys(env))
    if (k.startsWith('TMUXY_') && k !== 'TMUXY_CLI_DOC_SERVER') delete env[k];
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'),
    TMUX_TMPDIR: home,
    TMUX_SOCKET: 'tmuxy-cli-doc-nothing',
    TMUXY_SERVER_BIN: server,
  });
  const run = (argv) => {
    const r = spawnSync(path.join(ROOT, CLI), argv, {
      env,
      encoding: 'utf8',
      timeout: 30000,
      input: '',
    });
    const where = `\`${title(argv.filter((a) => a !== '--help'))} --help\``;
    // tmux's client makes its (empty) socket directory even when no server
    // answers; that is the only thing a help may leave behind.
    const touched = fs.readdirSync(home, { recursive: true }).filter((f) => !/^tmux-\d+$/.test(f));
    if (touched.length) {
      throw new Error(
        `${where} created ${touched.join(', ')} in a throwaway home: help must exit before touching anything`,
      );
    }
    const out = r.stdout.trim() ? r.stdout : r.stderr;
    if (r.status !== 0 || !out.trim()) {
      throw new Error(
        `${where} exited ${r.status} (${(r.stderr || '').trim().split('\n')[0] || 'no output'})`,
      );
    }
    return out;
  };
  const cleanup = () => fs.rmSync(home, { recursive: true, force: true });
  return { run, cleanup };
}

export function generate() {
  const { run, cleanup } = makeRunner(findServer());
  try {
    return render(walk(run));
  } finally {
    cleanup();
  }
}

function committedDocs() {
  const files = new Map();
  const dir = path.join(ROOT, DOCS);
  for (const name of fs.readdirSync(dir)) {
    if (name === 'CLI.md' || /^CLI-[A-Z]+\.md$/.test(name)) {
      files.set(name, fs.readFileSync(path.join(dir, name), 'utf8'));
    }
  }
  return files;
}

/** Errors (strings) for the policy check; empty when the docs match the help. */
export function checkCliReference(files = generate()) {
  const committed = committedDocs();
  const same =
    committed.size === files.size &&
    [...files].every(([name, text]) => committed.get(name) === text);
  if (same) return [];
  const changed = changedCommands(committed, files);
  const fileDiff = [...new Set([...committed.keys(), ...files.keys()])].filter(
    (n) => committed.get(n) !== files.get(n),
  );
  return [
    `[cli-reference] docs/${fileDiff.join(', docs/')} differ from the CLI's --help` +
      (changed.length ? ` (changed: ${changed.map((c) => '`' + c + '`').join(', ')})` : '') +
      `. Run \`${REGENERATE}\` and commit the result.`,
  ];
}

function main() {
  const check = process.argv.includes('--check');
  let files;
  try {
    files = generate();
  } catch (e) {
    console.error(`cli-reference: ${e.message}`);
    process.exit(1);
  }
  if (check) {
    const errors = checkCliReference(files);
    for (const e of errors) console.error(e);
    process.exit(errors.length ? 1 : 0);
  }
  for (const stale of committedDocs().keys()) {
    if (!files.has(stale)) fs.rmSync(path.join(ROOT, DOCS, stale));
  }
  for (const [name, text] of files) fs.writeFileSync(path.join(ROOT, DOCS, name), text);
  console.log(`cli-reference: wrote ${[...files.keys()].map((n) => `docs/${n}`).join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
