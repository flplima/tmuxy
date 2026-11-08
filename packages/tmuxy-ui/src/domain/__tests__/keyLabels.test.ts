import { describe, it, expect } from 'vitest';
import {
  clientKeyHint,
  formatKey,
  keyHint,
  pluginKeyHint,
  tableKeyLabel,
  tableKeysFor,
} from '../keyLabels';
import { TmuxOp } from '../commands';
import { script } from '../commandHelpers';
import type { KeyBindings } from '../wire';

/** tmux's own `&`, as `list-keys` prints it. */
const BINDINGS: KeyBindings = {
  prefix_key: 'C-a',
  repeat_time_ms: 300,
  prefix_bindings: [
    { key: '&', command: 'confirm-before -p "kill-window #W? (y/n)" kill-window', description: '' },
    { key: 'c', command: 'new-window -c "#{pane_current_path}"', description: '' },
  ],
  root_bindings: [],
  tables: {},
};

describe('keyHint', () => {
  it('names the binding whose command is the op, however the op spells its own', () => {
    // The close-tab op's command ends in the stash sweep; the binding is
    // still its hint.
    expect(keyHint(BINDINGS, TmuxOp.KillWindow({ windowId: null }))).toBe('ctrl+a &');
    expect(keyHint(BINDINGS, TmuxOp.NewWindow())).toBe('ctrl+a c');
  });

  it('is nothing for an op no key is bound to', () => {
    expect(keyHint(BINDINGS, TmuxOp.KillPane({ paneId: null }))).toBeUndefined();
    expect(keyHint(null, TmuxOp.NewWindow())).toBeUndefined();
  });
});

/** Bindings as tmuxy's default config and tmux's own defaults leave them, as `list-keys` prints them. */
const REAL: KeyBindings = {
  prefix_key: 'C-a',
  repeat_time_ms: 300,
  prefix_bindings: [
    { key: '-', command: 'split-window -v -c "#{pane_current_path}"', description: '' },
    { key: '|', command: 'split-window -h -c "#{pane_current_path}"', description: '' },
    { key: 'c', command: 'new-window -c "#{pane_current_path}"', description: '' },
    { key: 'x', command: 'confirm-before -p "kill-pane #P? (y/n)" kill-pane', description: '' },
    { key: '&', command: 'confirm-before -p "kill-window #W? (y/n)" kill-window', description: '' },
    { key: 'z', command: 'resize-pane -Z', description: '' },
  ],
  root_bindings: [],
  tables: {},
};

describe('keyHint against the real config', () => {
  it("finds the real config's bindings for the menus' ops", () => {
    expect(keyHint(REAL, TmuxOp.Split({ direction: 'horizontal' }))).toBe('ctrl+a -');
    expect(keyHint(REAL, TmuxOp.Split({ direction: 'vertical' }))).toBe('ctrl+a |');
    expect(keyHint(REAL, TmuxOp.NewWindow())).toBe('ctrl+a c');
    expect(keyHint(REAL, TmuxOp.KillPane({ paneId: null }))).toBe('ctrl+a x');
    expect(keyHint(REAL, TmuxOp.ZoomToggle({ paneId: null }))).toBe('ctrl+a z');
  });

  it('matches what a binding does, not something that only shares its name', () => {
    expect(keyHint(REAL, TmuxOp.RawCommand({ command: 'split-window' }))).toBeUndefined();
    expect(keyHint(REAL, TmuxOp.RawCommand({ command: 'kill-pane -a' }))).toBeUndefined();
  });
});

/** The sticky modes, as tmuxy.defaults.conf binds them and `list-keys` expands their aliases. */
const MODES: KeyBindings = {
  prefix_key: 'C-a',
  repeat_time_ms: 300,
  prefix_bindings: [
    { key: 'p', command: 'switch-client -T pane', description: '' },
    { key: 't', command: 'switch-client -T tab', description: '' },
  ],
  root_bindings: [{ key: 'C-h', command: 'tmuxy-nav-left', description: '' }],
  tables: {
    pane: [
      { key: 'h', command: 'tmuxy-nav-left', description: '' },
      {
        key: 'S',
        command: 'run-shell "bash /home/u/.local/share/tmuxy/bin/tmuxy/stack toggle #{window_id}"',
        description: '',
      },
      { key: 'BSpace', command: 'kill-pane', description: '' },
    ],
    tab: [{ key: '3', command: 'select-window -t 3', description: '' }],
  },
};

describe('keys in every table', () => {
  it('names a mode key after the prefix key that enters the mode', () => {
    const stackToggle = TmuxOp.RawCommand({ command: script('stack', 'toggle', '#{window_id}') });
    expect(keyHint(MODES, stackToggle)).toBe('ctrl+a p S');
    expect(keyHint(MODES, TmuxOp.KillPane({ paneId: null }))).toBe('ctrl+a p BS');
    expect(tableKeyLabel(MODES, 'nowhere', 'x')).toBeUndefined();
  });

  it('prefers the prefix table, then root, then the modes', () => {
    expect(keyHint(MODES, TmuxOp.Navigate({ direction: 'L', script: true }))).toBe('ctrl+h');
    expect(tableKeysFor(MODES, 'pane', TmuxOp.Navigate({ direction: 'L', script: true }))).toEqual([
      'h',
    ]);
  });

  it("names the client's own keys from its table, or its chord", () => {
    expect(clientKeyHint(MODES, 'left-sidebar')).toBe('ctrl+a s');
    expect(clientKeyHint(MODES, 'right-sidebar')).toBe('ctrl+a S');
    expect(clientKeyHint(MODES, 'tab-left')).toBe('ctrl+a t <');
    expect(clientKeyHint(null, 'tab-overview')).toBe('ctrl+0');
    expect(clientKeyHint(null, 'left-sidebar')).toBeUndefined();
  });

  it("finds a plugin's key in any table", () => {
    const bound: KeyBindings = {
      ...MODES,
      root_bindings: [
        {
          key: 'M-y',
          command: 'run-shell "#{q:@tmuxy-cli} plugin action yank:copy --trigger key"',
          description: '',
        },
      ],
    };
    expect(pluginKeyHint(bound, 'yank', 'copy')).toBe('alt+y');
    expect(pluginKeyHint(bound, 'yank', 'paste')).toBeUndefined();
  });
});

describe('formatKey', () => {
  it('spells modifiers and named keys the one way the app shows them', () => {
    expect(formatKey('C-a')).toBe('ctrl+a');
    expect(formatKey('C-A')).toBe('ctrl+a');
    expect(formatKey('C-Space')).toBe('ctrl+Space');
    expect(formatKey('M-Up')).toBe('alt+\u2191');
    expect(formatKey('C-S-Tab')).toBe('ctrl+shift+Tab');
    expect(formatKey('S')).toBe('S');
    expect(formatKey('-')).toBe('-');
  });
});
