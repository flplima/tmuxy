import { describe, it, expect } from 'vitest';
import { preserveSnapshotIdentity } from '../adapters';
import type { TmuxSnapshot } from '../types';
import type { TmuxPane } from '../../types';

/**
 * The store keeps the PREVIOUS pane object whenever a pane is "unchanged", so
 * any field left out of that comparison can never reach the UI.
 *
 * `@tmuxy-pane-state` is the worst case for it: a pane declaring what it is
 * doing changes nothing else about itself — no output, no geometry, no title —
 * so every other compared field matches and the old object wins. The tree then
 * shows `idle` forever, no matter what the pane says. (Zoom and a window's own
 * active pane were bitten by exactly this; see zoomIdentity.test.ts.)
 */
const pane = (over: Partial<TmuxPane> = {}): TmuxPane => ({
  id: 0,
  tmuxId: '%1',
  windowId: '@1',
  content: [],
  cursorX: 0,
  cursorY: 0,
  width: 80,
  height: 24,
  x: 0,
  y: 0,
  active: true,
  command: 'claude',
  title: '',
  borderTitle: ' ',
  inMode: false,
  copyCursorX: 0,
  copyCursorY: 0,
  alternateOn: false,
  mouseAnyFlag: false,
  paused: false,
  historySize: 0,
  selectionPresent: false,
  selectionStartX: 0,
  selectionStartY: 0,
  cursorShape: 0,
  cursorHidden: false,
  ...over,
});

const snap = (panes: TmuxPane[]): TmuxSnapshot =>
  ({
    panes,
    windows: [],
    activePaneId: '%1',
    activeWindowId: '@1',
    totalWidth: 80,
    totalHeight: 24,
    statusLine: '',
    focusRequest: '',
    sessionName: 'tmuxy',
  }) as unknown as TmuxSnapshot;

describe('preserveSnapshotIdentity — a pane declaring its state', () => {
  it('publishes a new pane object when a pane starts working', () => {
    const prev = snap([pane()]);
    const next = snap([pane({ paneState: 'working' })]);
    const result = preserveSnapshotIdentity(prev, next);

    expect(result).not.toBe(prev);
    expect(result.panes[0].paneState).toBe('working');
  });

  it('publishes a new pane object when the state changes between values', () => {
    // The transition that matters most: an agent going from busy to blocked is
    // the one moment the user has to be told about.
    const prev = snap([pane({ paneState: 'working' })]);
    const next = snap([pane({ paneState: 'needs-input' })]);
    const result = preserveSnapshotIdentity(prev, next);

    expect(result).not.toBe(prev);
    expect(result.panes[0].paneState).toBe('needs-input');
  });

  it('publishes a new pane object when the state is cleared', () => {
    // An agent unsetting the option on exit has to clear the badge too.
    const prev = snap([pane({ paneState: 'needs-input' })]);
    const next = snap([pane({ paneState: null })]);
    const result = preserveSnapshotIdentity(prev, next);

    expect(result).not.toBe(prev);
    expect(result.panes[0].paneState ?? null).toBeNull();
  });

  it('treats absent and null as the same, so identity is still preserved', () => {
    // The wire omits the field entirely for a pane that never declared one;
    // that must not look like a change on every tick.
    const prev = snap([pane({ paneState: null })]);
    const next = snap([pane()]);
    expect(preserveSnapshotIdentity(prev, next)).toBe(prev);
  });

  it('still preserves identity when nothing changed', () => {
    const prev = snap([pane({ paneState: 'working' })]);
    const next = snap([pane({ paneState: 'working' })]);
    expect(preserveSnapshotIdentity(prev, next)).toBe(prev);
  });
});
