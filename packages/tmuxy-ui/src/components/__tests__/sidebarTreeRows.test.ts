/**
 * The tree's rows: each tab, then its panes in grid order, and under a pane
 * that fronts a group the members parked behind it — which live in the stash
 * session's windows, so no window of the tab's own lists them, yet they are
 * the tab's panes.
 */

import { describe, expect, it } from 'vitest';
import { gid, pid, wid } from '../../test/wire';
import { buildTreeRows } from '../sidebarTreeRows';
import type { TmuxPane, TmuxWindow } from '../../domain/client';

const win = (id: string): TmuxWindow => ({ id: wid(id), name: id, active: false }) as TmuxWindow;
const pane = (id: string, windowId: string, x = 0, y = 0): TmuxPane =>
  ({ tmuxId: pid(id), windowId: wid(windowId), x, y, width: 40, height: 20 }) as TmuxPane;

const kinds = (rows: ReturnType<typeof buildTreeRows>) =>
  rows.map((r) =>
    r.kind === 'tab' ? `tab ${r.window.id}` : `${r.parkedBehind ? '  ' : ''}pane ${r.pane.tmuxId}`,
  );

describe('buildTreeRows', () => {
  it('lists a tab and its panes in grid order', () => {
    const rows = buildTreeRows(
      [win('@1')],
      [pane('%2', '@1', 40, 0), pane('%1', '@1', 0, 0)],
      new Set(),
      {},
    );
    expect(kinds(rows)).toEqual(['tab @1', 'pane %1', 'pane %2']);
    expect(rows[2]).toMatchObject({ last: true });
  });

  it('lists the members parked behind a group’s shown pane under it, in group order', () => {
    const rows = buildTreeRows(
      [win('@1')],
      [pane('%1', '@1'), pane('%7', '@9'), pane('%4', '@9'), pane('%2', '@1', 40, 0)],
      new Set(),
      { g1: { id: gid('g1'), paneIds: [pid('%4'), pid('%1'), pid('%7')] } },
    );
    expect(kinds(rows)).toEqual(['tab @1', 'pane %1', '  pane %4', '  pane %7', 'pane %2']);
    expect(rows[2]).toMatchObject({ parkedBehind: pid('%1'), window: { id: wid('@1') } });
    // The branch's end moves to the last parked member when the shown pane
    // was the tab's last.
    const only = buildTreeRows([win('@1')], [pane('%1', '@1'), pane('%7', '@9')], new Set(), {
      g1: { id: gid('g1'), paneIds: [pid('%1'), pid('%7')] },
    });
    expect(only.map((r) => r.kind === 'pane' && r.last)).toEqual([false, false, true]);
  });

  it('a member the model has not listed yet is simply absent', () => {
    const rows = buildTreeRows([win('@1')], [pane('%1', '@1')], new Set(), {
      g1: { id: gid('g1'), paneIds: [pid('%1'), pid('%99')] },
    });
    expect(kinds(rows)).toEqual(['tab @1', 'pane %1']);
  });

  it('a collapsed tab lists nothing under it', () => {
    const rows = buildTreeRows(
      [win('@1')],
      [pane('%1', '@1'), pane('%7', '@9')],
      new Set([wid('@1')]),
      { g1: { id: gid('g1'), paneIds: [pid('%1'), pid('%7')] } },
    );
    expect(kinds(rows)).toEqual(['tab @1']);
  });
});
