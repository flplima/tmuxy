import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindings,
  catalogRows,
  checkFeaturesCatalog,
  cliCommands,
  menuIds,
  options,
} from './features-catalog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('the capability catalog', () => {
  it('holds the code as it is today, in both directions', () => {
    const errors = [];
    checkFeaturesCatalog(ROOT, (e) => errors.push(e));
    expect(errors).toEqual([]);
  });

  it('reads menu ids, op-table keys and the prefixes of ids built at run time', () => {
    const ids = menuIds([
      "{ kind: 'item', id: 'pane-close', label: 'Close' }",
      "const OPS = {\n  'pane-split-below': TmuxOp.Split({}),\n};",
      'id: `theme-mode-${mode}`,',
    ]);
    expect([...ids].sort()).toEqual(['pane-close', 'pane-split-below', 'theme-mode-*']);
  });

  it('reads each binding as its table and key', () => {
    const conf = [
      'bind - split-window -v',
      "bind '\"' split-window -v",
      'bind \\\\ split-window -h',
      'bind -r H resize-pane -L 5',
      'bind -n C-h tmuxy-nav-left',
      'bind -T pane x kill-pane',
      'bind-key -T copy-mode-vi v send-keys -X begin-selection',
      '# bind q nothing',
    ].join('\n');
    expect([...bindings(conf)]).toEqual([
      'prefix -',
      'prefix "',
      'prefix \\',
      'prefix H',
      'root C-h',
      'pane x',
      'copy-mode-vi v',
    ]);
  });

  it('names a noun by its verbs, and a noun without verbs by itself', () => {
    const dispatch = 'case "${1:-}" in\n  pane)\n    ;;\n  open|gui)\n    ;;\nesac';
    const script =
      'cmd_pane() {\n  case "$1" in\n    split)\n      ;;\n    kill|close)\n      ;;\n  esac\n}';
    const { commands } = cliCommands(dispatch, [script]);
    expect([...commands].sort()).toEqual([
      'tmuxy gui',
      'tmuxy open',
      'tmuxy pane close',
      'tmuxy pane kill',
      'tmuxy pane split',
    ]);
  });

  it('takes user options from the defaults and known ones from the constants', () => {
    const { user, known } = options(
      'set -g @tmuxy-blur on\nsetw -g @tmuxy-nope x',
      'pub const LABEL: &str = "@tmuxy-label";',
    );
    expect([...user]).toEqual(['@tmuxy-blur']);
    expect(known.has('@tmuxy-label') && known.has('@tmuxy-blur')).toBe(true);
  });

  it('reads a row by its columns, with an escaped pipe as a key', () => {
    const doc = [
      '| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| P2 | Split right | — | `pane-split-right` | `prefix \\|` `pane \\|` | `tmuxy pane split` | — | — |',
    ].join('\n');
    const [row] = catalogRows([['docs/FEATURES.md', doc]]);
    expect(row.id).toBe('P2');
    expect(row.tokens).toEqual({
      menu: ['pane-split-right'],
      keys: ['prefix |', 'pane |'],
      cli: ['tmuxy pane split'],
      config: [],
    });
  });
});
