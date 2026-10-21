/**
 * The v86 transport's key table against the tmuxy.defaults.conf the app
 * ships: the two were written by hand twice and drifted once.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDINGS } from '../v86/defaultKeybindings';

const CONF = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../tmuxy-core/assets/tmuxy.defaults.conf',
);

interface Bind {
  table: string;
  key: string;
  command: string;
}

/** Every `bind` line of the conf: its table (`root`, `prefix` or `-T`'s), key and command. */
function confBindings(): Bind[] {
  const binds: Bind[] = [];
  for (const line of readFileSync(CONF, 'utf8').split('\n')) {
    const m = line.match(/^bind(?:-key)?\s+(.*)$/);
    if (!m) continue;
    const tokens = m[1].split(/\s+/);
    let table = 'prefix';
    // A flag is a letter after the dash; a bare `-` is the key it binds.
    while (/^-[a-zA-Z]$/.test(tokens[0] ?? '')) {
      const flag = tokens.shift();
      if (flag === '-n') table = 'root';
      if (flag === '-T') table = tokens.shift() ?? table;
    }
    // The conf quotes `"` and escapes `\` for tmux's parser; the table holds the key itself.
    const key = (tokens.shift() ?? '').replace(/^'(.*)'$/, '$1').replace(/^\\\\$/, '\\');
    binds.push({ table, key, command: normal(tokens.join(' ')) });
  }
  return binds;
}

/**
 * A command as the two spell it in common: the guest has no `pane_current_path`
 * to split at, and a sticky binding's re-entry into its table is the table's
 * business, not the key's.
 */
function normal(command: string): string {
  return command
    .replace(/ -c "#\{pane_current_path\}"/g, '')
    .replace(/ \\; switch-client -T \w+$/, '')
    .trim();
}

const byKey = (binds: Bind[], table: string) =>
  new Map(binds.filter((b) => b.table === table).map((b) => [b.key, b.command]));

describe('the v86 key table against the shipped tmuxy.defaults.conf', () => {
  const conf = confBindings();

  it('binds exactly the root keys the conf binds, to the same commands', () => {
    const table = new Map(DEFAULT_KEYBINDINGS.root_bindings.map((b) => [b.key, normal(b.command)]));
    expect(table).toEqual(byKey(conf, 'root'));
  });

  it('binds the prefix keys the conf binds to the same commands, and otherwise only tmux defaults', () => {
    const confPrefix = byKey(conf, 'prefix');
    // tmux's own defaults the conf leaves in place.
    const tmuxDefaults = ['n', 'x', '&', 'o', 'z', 'Up', 'Down', 'Left', 'Right', '[', 'Space'];
    const windowByIndex = /^[0-9]$/;
    for (const { key, command } of DEFAULT_KEYBINDINGS.prefix_bindings) {
      if (confPrefix.has(key)) expect([key, normal(command)]).toEqual([key, confPrefix.get(key)]);
      else expect(tmuxDefaults.includes(key) || windowByIndex.test(key), key).toBe(true);
    }
    // What the conf binds and the table leaves out: the prefix itself, and a
    // chooser the guest cannot drive.
    const omitted = ['C-a', 'a', 'j'];
    const tableKeys = new Set(DEFAULT_KEYBINDINGS.prefix_bindings.map((b) => b.key));
    for (const key of confPrefix.keys()) {
      expect(tableKeys.has(key) || omitted.includes(key), `prefix ${key}`).toBe(true);
    }
  });

  it('fills the pane and tab tables with the conf’s keys and commands', () => {
    // The conf's keys the guest leaves out: stacks, floats, marks, prompts
    // and choosers, which the guest's tmuxy build does not carry.
    const omitted: Record<string, string[]> = {
      pane: ['s', 'S', '=', 'f', 'm', ',', 'g'],
      tab: [],
    };
    for (const [name, bindings] of Object.entries(DEFAULT_KEYBINDINGS.tables ?? {})) {
      const confTable = byKey(conf, name);
      for (const { key, command } of bindings) {
        expect([name, key, normal(command)]).toEqual([name, key, confTable.get(key)]);
      }
      const tableKeys = new Set(bindings.map((b) => b.key));
      for (const key of confTable.keys()) {
        expect(tableKeys.has(key) || omitted[name].includes(key), `${name} ${key}`).toBe(true);
      }
    }
  });
});
