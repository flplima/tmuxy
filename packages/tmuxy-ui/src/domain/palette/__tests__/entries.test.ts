import { describe, it, expect } from 'vitest';
import { recentFirst, rememberRecent, specEntries } from '../entries';
import type { MenuSpec } from '../../menus/spec';

const SPEC: MenuSpec<string> = [
  { kind: 'item', id: 'top', label: 'Top Level…', action: 'top', keyHint: 'ctrl+a t' },
  { kind: 'separator' },
  {
    kind: 'submenu',
    id: 'menu-pane',
    label: 'Pane',
    children: [
      { kind: 'item', id: 'split', label: 'Split', action: 'split', icon: 'split-right' },
      { kind: 'item', id: 'off', label: 'Off', action: 'off', disabled: true },
      { kind: 'predefined', which: 'copy' },
      {
        kind: 'submenu',
        id: 'pane-plugins',
        label: 'Plugins',
        children: [
          { kind: 'header', label: 'notes' },
          { kind: 'item', id: 'plugin:notes:open', label: 'Open Notes', action: 'notes' },
          { kind: 'separator' },
          { kind: 'item', id: 'plugin:x:run', label: 'Run', action: 'x' },
        ],
      },
    ],
  },
  {
    kind: 'submenu',
    id: 'menu-view',
    label: 'View',
    children: [
      { kind: 'checkbox', id: 'blink', label: 'Blinking Cursor', checked: true, action: 'blink' },
      {
        kind: 'radio-group',
        id: 'level',
        value: 'full',
        options: [
          { value: 'shape', label: 'Shape', action: 'shape' },
          { value: 'full', label: 'Full', action: 'full' },
          { value: 'none', label: 'None', action: 'none', disabled: true },
        ],
      },
      // The same item under a second menu is the same thing to run.
      { kind: 'item', id: 'split', label: 'Split', action: 'split' },
    ],
  },
  { kind: 'submenu', id: 'menu-off', label: 'Off', disabled: true, children: SUB() },
];

function SUB(): MenuSpec<string> {
  return [{ kind: 'item', id: 'hidden', label: 'Hidden', action: 'hidden' }];
}

describe('specEntries', () => {
  const entries = specEntries(SPEC);
  const byId = (id: string) => entries.find((entry) => entry.id === id);

  it('lists every enabled item once, submenus included, in menu order', () => {
    expect(entries.map((entry) => entry.id)).toEqual([
      'action:top',
      'action:split',
      'action:plugin:notes:open',
      'action:plugin:x:run',
      'action:blink',
      'action:level:shape',
      'action:level:full',
    ]);
  });

  it('carries the label, key hint, icon and action of the item', () => {
    expect(byId('action:top')).toMatchObject({
      kind: 'action',
      label: 'Top Level',
      keyHint: 'ctrl+a t',
      action: 'top',
    });
    expect(byId('action:split')).toMatchObject({ icon: 'split-right', action: 'split' });
  });

  it('says where an item is from: its submenus, and the header it sits under', () => {
    expect(byId('action:top')?.detail).toBeUndefined();
    expect(byId('action:split')?.detail).toBe('Pane');
    expect(byId('action:plugin:notes:open')?.detail).toBe('Pane › Plugins › notes');
    // The separator ended the header's section.
    expect(byId('action:plugin:x:run')?.detail).toBe('Pane › Plugins');
  });

  it('gives a checkbox its state and a radio group one entry an option', () => {
    expect(byId('action:blink')?.checked).toBe(true);
    expect(byId('action:level:shape')).toMatchObject({ checked: false, action: 'shape' });
    expect(byId('action:level:full')).toMatchObject({ checked: true, detail: 'View' });
  });

  it('leaves out the ids it is asked to', () => {
    const ids = specEntries(SPEC, { omit: new Set(['top']) }).map((entry) => entry.id);
    expect(ids).not.toContain('action:top');
    expect(ids).toContain('action:split');
  });
});

describe('recent entries', () => {
  const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('moves the remembered ones to the front, most recent first', () => {
    const { recent, rest } = recentFirst(entries, ['c', 'gone', 'a']);
    expect(recent.map((e) => e.id)).toEqual(['c', 'a']);
    expect(rest.map((e) => e.id)).toEqual(['b']);
  });

  it('remembers the latest choice first, once, up to the limit', () => {
    expect(rememberRecent(['a', 'b'], 'b')).toEqual(['b', 'a']);
    expect(rememberRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });
});
