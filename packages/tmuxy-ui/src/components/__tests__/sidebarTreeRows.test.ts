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
    r.kind === 'tab'
      ? `tab ${r.window.id}`
      : `pane ${r.pane.tmuxId}${r.parkedBehind ? ' (parked)' : ''}`,
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

  it('lists a group at its slot with all its members, in group order, at one level', () => {
    const groups = { g1: { id: gid('g1'), paneIds: [pid('%4'), pid('%1'), pid('%7')] } };
    const rows = buildTreeRows(
      [win('@1')],
      [pane('%1', '@1'), pane('%7', '@9'), pane('%4', '@9'), pane('%2', '@1', 40, 0)],
      new Set(),
      groups,
    );
    expect(kinds(rows)).toEqual([
      'tab @1',
      'pane %4 (parked)',
      'pane %1',
      'pane %7 (parked)',
      'pane %2',
    ]);
    expect(rows[1]).toMatchObject({ parkedBehind: pid('%1'), window: { id: wid('@1') } });
    expect(rows.map((r) => r.kind === 'pane' && r.last)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('keeps the rows where they are when another member is shown', () => {
    const groups = { g1: { id: gid('g1'), paneIds: [pid('%4'), pid('%1'), pid('%7')] } };
    const ids = (shown: string, parked: string[]) =>
      buildTreeRows(
        [win('@1')],
        [pane(shown, '@1'), ...parked.map((id) => pane(id, '@9'))],
        new Set(),
        groups,
      ).map((r) => (r.kind === 'pane' ? r.pane.tmuxId : r.window.id));
    expect(ids('%1', ['%4', '%7'])).toEqual(ids('%7', ['%4', '%1']));
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
