import { describe, it, expect } from 'vitest';
import { boundAction, getKeybindingLabel } from '../keybindingLabel';
import type { KeyBindings } from '../../../domain/wire';

/** Bindings as tmuxy's default config and tmux's own defaults leave them, as `list-keys` prints them. */
const REAL: KeyBindings = {
  prefix_key: 'C-a',
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

describe('getKeybindingLabel', () => {
  it("finds the real config's bindings for the menus' plain commands", () => {
    expect(getKeybindingLabel(REAL, 'split-window -v')).toBe('ctrl+a -');
    expect(getKeybindingLabel(REAL, 'split-window -h')).toBe('ctrl+a |');
    expect(getKeybindingLabel(REAL, 'new-window')).toBe('ctrl+a c');
    expect(getKeybindingLabel(REAL, 'kill-pane')).toBe('ctrl+a x');
    expect(getKeybindingLabel(REAL, 'resize-pane -Z')).toBe('ctrl+a z');
  });

  it('matches what a binding does, not something that only shares its name', () => {
    expect(getKeybindingLabel(REAL, 'split-window')).toBeUndefined();
    expect(getKeybindingLabel(REAL, 'kill-pane -a')).toBeUndefined();
  });
});

describe('boundAction', () => {
  it('unwraps confirm-before with its flags and a quoted command', () => {
    expect(boundAction('confirm-before -y -p "really? (y/n)" "kill-session"')).toBe('kill-session');
    expect(boundAction("confirm-before -p 'go?' kill-server")).toBe('kill-server');
  });

  it('drops the directory a split or a new window starts in, however it is quoted', () => {
    expect(boundAction("split-window -h -c '#{pane_current_path}'")).toBe('split-window -h');
    expect(boundAction('new-window -c #{pane_current_path}')).toBe('new-window');
  });
});
