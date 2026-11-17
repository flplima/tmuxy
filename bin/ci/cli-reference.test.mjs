import { describe, expect, it } from 'vitest';
import {
  changedCommands,
  parseHelp,
  render,
  sections,
  stripVersion,
  summary,
  walk,
} from './cli-reference.mjs';

const TOP = `tmuxy 1.2.3 — a thing

Usage: tmuxy <command> [args...]

Commands:
  pane        Manage panes (split, kill)
  config      Re-apply the config
  tab         Manage tabs [--json]

Options:
  -h, --help    Show this help
`;

const PANE = `Usage: tmuxy pane <command> [args...]

Commands:
  list          List all panes [--json] [--all]
  group         Pane group operations (see 'tmuxy pane group --help')

A target is a pane id.
`;

const CONFIG = `Usage: tmuxy config <setting> [value]

Settings:
  reload                   Re-apply the config to the running app: the whole
                           chain is re-sourced.
  check [file] [--json]    What is wrong with your config.
  use-tmux-conf [on|off]   Source your own ~/.tmux.conf.

Exit codes:
  0    ok
`;

const CLAP = `Usage: tmuxy-server [OPTIONS] [COMMAND]

Commands:
  stop    Stop it
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
`;

describe('parseHelp', () => {
  it('reads the names of a Commands block, not its wrapped text or the blocks after it', () => {
    expect(parseHelp(TOP).commands).toEqual(['pane', 'config', 'tab']);
    expect(parseHelp(PANE).commands).toEqual(['list', 'group']);
  });

  it('reads a Settings block apart from the commands, with their wrapped lines skipped', () => {
    expect(parseHelp(CONFIG)).toEqual({
      commands: [],
      settings: ['reload', 'check', 'use-tmux-conf'],
    });
  });

  it('leaves out the help entry clap adds', () => {
    expect(parseHelp(CLAP).commands).toEqual(['stop']);
  });

  it('finds none in a help with no block', () => {
    expect(parseHelp('Usage: tmuxy info [--json]\n')).toEqual({ commands: [], settings: [] });
  });
});

describe('walk', () => {
  const helps = {
    '': TOP,
    pane: PANE,
    'pane list': 'Usage: tmuxy pane list\n',
    'pane group': 'Usage: tmuxy pane group <op>\n\nCommands:\n  add    Add\n',
    'pane group add': 'Usage: tmuxy pane group add\n',
    config: CONFIG,
    tab: TOP, // prints its parent's help: not a command of its own
  };
  const run = (argv) => helps[argv.filter((a) => a !== '--help').join(' ')];

  it("visits each command and nested subcommand in help order, and drops one that prints its parent's help", () => {
    const tree = walk(run);
    const paths = [];
    const visit = (n) => {
      paths.push(n.path.join(' '));
      n.children.forEach(visit);
    };
    visit(tree);
    expect(paths).toEqual(['', 'pane', 'pane list', 'pane group', 'pane group add', 'config']);
  });

  it('never runs a setting, which would act instead of describe', () => {
    const asked = [];
    walk((argv) => {
      asked.push(argv.join(' '));
      return run(argv);
    });
    expect(asked.some((a) => a.includes('reload'))).toBe(false);
  });
});

describe('render', () => {
  const tree = walk((argv) => {
    const key = argv.filter((a) => a !== '--help').join(' ');
    if (key === '') return TOP;
    if (key === 'pane') return PANE + 'x'.repeat(3000);
    if (key === 'pane list') return 'Usage: tmuxy pane list\n';
    if (key === 'pane group') return 'Usage: tmuxy pane group\n';
    if (key === 'config') return CONFIG;
    return 'Usage: tmuxy tab\n';
  });
  const files = render(tree);

  it('puts a long command in its own doc and links it from the index', () => {
    expect([...files.keys()].sort()).toEqual(['CLI-PANE.md', 'CLI.md']);
    expect(files.get('CLI.md')).toContain('[CLI-PANE.md](CLI-PANE.md)');
    expect(files.get('CLI.md')).toContain('Manage panes (split, kill)');
    expect(files.get('CLI-PANE.md')).toContain('### `tmuxy pane list`');
  });

  it('shows each help verbatim in a text block, with no version', () => {
    expect(files.get('CLI.md')).toContain('```text\ntmuxy — a thing');
    expect(files.get('CLI.md')).not.toContain('1.2.3');
  });
});

describe('the pieces', () => {
  it('strips the version from the first line only', () => {
    expect(stripVersion('tmuxy 0.1.6 — AI-first\nx 0.1.6')).toBe('tmuxy — AI-first\nx 0.1.6');
  });

  it('finds a command summary in the top help', () => {
    expect(summary(TOP, 'pane')).toBe('Manage panes (split, kill)');
  });

  it('names the commands whose section changed, appeared or went', () => {
    const doc = (a, b) =>
      new Map([['CLI.md', `# x\n\n## \`tmuxy a\`\n\n${a}\n\n## \`tmuxy b\`\n\n${b}\n`]]);
    expect(changedCommands(doc('1', '2'), doc('1', '3'))).toEqual(['tmuxy b']);
    expect(changedCommands(doc('1', '2'), doc('1', '2'))).toEqual([]);
    expect([...sections(doc('1', '2').get('CLI.md')).keys()]).toEqual([
      '(header)',
      'tmuxy a',
      'tmuxy b',
    ]);
  });
});
