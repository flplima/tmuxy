import { describe, expect, it } from 'vitest';
import type { PaneId } from '../../domain/ids';
import { gid, pid, wid } from '../../test/wire';
import {
  groupDropAt,
  groupDropCommand,
  headerBands,
  leaveCommand,
  sideOf,
  type HeaderBand,
} from '../groupDrop';
import type { TmuxPane } from '../../domain/client';

// A header 300px wide at the top of the container, shared by three members.
const band = (members: PaneId[], paneId = members[0]): HeaderBand => ({
  paneId,
  left: 0,
  top: 0,
  right: 300,
  bottom: 20,
  members,
});

describe('a pane dragged over a header', () => {
  it('a member takes the share under the pointer in its own group', () => {
    const bands = [band([pid('%1'), pid('%2'), pid('%3')])];
    expect(groupDropAt(bands, pid('%1'), true, 250, 10)).toEqual({
      kind: 'order',
      paneId: pid('%1'),
      from: 0,
      index: 2,
    });
    expect(groupDropAt(bands, pid('%3'), true, 10, 10)).toMatchObject({ from: 2, index: 0 });
  });

  it('an ungrouped pane joins at the gap nearest the pointer', () => {
    const bands = [band([pid('%1'), pid('%2'), pid('%3')])];
    expect(groupDropAt(bands, pid('%9'), false, 10, 10)).toEqual({
      kind: 'join',
      anchorPaneId: pid('%1'),
      index: 0,
    });
    expect(groupDropAt(bands, pid('%9'), false, 160, 10)).toMatchObject({ index: 2 });
    expect(groupDropAt(bands, pid('%9'), false, 299, 10)).toMatchObject({ index: 3 });
  });

  it('nothing over its own lone header, another group while grouped, or below the header', () => {
    expect(groupDropAt([band([pid('%1')])], pid('%1'), false, 10, 10)).toBeNull();
    expect(groupDropAt([band([pid('%1'), pid('%2')])], pid('%9'), true, 10, 10)).toBeNull();
    expect(groupDropAt([band([pid('%1'), pid('%2')])], pid('%9'), false, 10, 40)).toBeNull();
  });

  it('the header row is the top row of the pane box the swap hit test uses', () => {
    const pane = { tmuxId: pid('%4'), x: 10, y: 5, width: 20, height: 8 } as TmuxPane;
    const [b] = headerBands(
      [pane],
      { [gid('g1')]: { id: gid('g1'), paneIds: [pid('%4'), pid('%7')] } },
      10,
      20,
      0,
      0,
    );
    expect(b.members).toEqual([pid('%4'), pid('%7')]);
    expect(b.top).toBeLessThan(5 * 20);
    expect(b.bottom).toBeLessThanOrEqual(5 * 20 + 1);
    expect(b.right - b.left).toBeGreaterThanOrEqual(20 * 10);
  });
});

describe('the command a release runs', () => {
  it('moves, joins, or does nothing when the member is already there', () => {
    expect(
      groupDropCommand({ kind: 'order', paneId: pid('%1'), from: 0, index: 2 }, pid('%1')),
    ).toContain('pane-group-move %1 2');
    expect(
      groupDropCommand({ kind: 'order', paneId: pid('%1'), from: 1, index: 1 }, pid('%1')),
    ).toBeNull();
    expect(
      groupDropCommand({ kind: 'join', anchorPaneId: pid('%1'), index: 0 }, pid('%9')),
    ).toContain('pane-group-join %9 %1 0');
  });

  it('a parked member leaves beside a pane, into a tab, or as a tab of its own', () => {
    expect(leaveCommand(pid('%5'), { kind: 'beside', paneId: pid('%2'), side: 'up' })).toContain(
      'pane-group-leave %5 --beside %2 up',
    );
    expect(leaveCommand(pid('%5'), { kind: 'tab', windowId: wid('@3') })).toContain(
      '--beside @3 right',
    );
    expect(leaveCommand(pid('%5'), { kind: 'new' })).toContain('pane-group-leave %5 --tab');
  });

  it('picks the side of a pane by the pointer, relative to its shape', () => {
    const box = { left: 0, top: 0, right: 400, bottom: 100 };
    expect(sideOf(box, 20, 50)).toBe('left');
    expect(sideOf(box, 390, 50)).toBe('right');
    expect(sideOf(box, 200, 5)).toBe('up');
    expect(sideOf(box, 200, 95)).toBe('down');
  });
});
