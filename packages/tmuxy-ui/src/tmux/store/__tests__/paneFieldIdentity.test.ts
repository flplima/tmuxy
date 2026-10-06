import { describe, it, expect } from 'vitest';
import { preserveSnapshotIdentity } from '../adapters';
import type { TmuxSnapshot } from '../types';
import type { TmuxPane } from '../../types';

/**
 * The store keeps the PREVIOUS pane object whenever its comparison says the
 * pane is unchanged, so a field the comparison leaves out never reaches the UI
 * when it is the only thing that changed. That has happened field by field —
 * zoom, a pane's declared state, a group member's place in its group — each
 * found as a bug. This walks every field instead, so a new one fails here.
 */
const full: TmuxPane = {
  id: 0,
  tmuxId: '%1',
  windowId: '@1',
  groupId: 'g1',
  groupPos: 1,
  content: [],
  cursorX: 0,
  cursorY: 0,
  width: 80,
  height: 24,
  x: 0,
  y: 0,
  active: true,
  command: 'zsh',
  title: 't',
  borderTitle: ' ',
  inMode: false,
  copyCursorX: 0,
  copyCursorY: 0,
  alternateOn: false,
  mouseAnyFlag: false,
  marked: false,
  paused: false,
  historySize: 0,
  selectionPresent: false,
  selectionStartX: 0,
  selectionStartY: 0,
  images: [],
  cursorShape: 0,
  cursorHidden: false,
  paneState: 'idle',
  paneAsk: null,
  paneWidget: null,
};

/** Fields that are not the pane's to show: identity, content (compared by line). */
const NOT_COMPARED = new Set(['id', 'tmuxId', 'content']);

const changed = (value: unknown): unknown => {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'string') return `${value}-x`;
  if (Array.isArray(value)) return [{ id: 1 }];
  return 'set';
};

const snap = (pane: TmuxPane): TmuxSnapshot =>
  ({
    panes: [pane],
    windows: [],
    activePaneId: '%1',
    activeWindowId: '@1',
    totalWidth: 80,
    totalHeight: 24,
    focusRequest: '',
    sessionName: 'tmuxy',
  }) as unknown as TmuxSnapshot;

describe('preserveSnapshotIdentity — every pane field', () => {
  for (const key of Object.keys(full).filter((k) => !NOT_COMPARED.has(k))) {
    it(`a change to ${key} alone reaches the UI`, () => {
      const prev = snap(full);
      const next = snap({ ...full, [key]: changed(full[key as keyof TmuxPane]) });
      const result = preserveSnapshotIdentity(prev, next);
      expect(result.panes[0]).not.toBe(prev.panes[0]);
    });
  }

  it('an unchanged pane keeps its object', () => {
    expect(preserveSnapshotIdentity(snap(full), snap({ ...full })).panes[0]).toBe(full);
  });
});
