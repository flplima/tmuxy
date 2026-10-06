import { describe, expect, it } from 'vitest';
import { gid, pid } from '../../../test/wire';
import { buildGroupsFromPanes } from '../helpers';
import type { TmuxPane } from '../../../domain/client';
import type { GroupId, PaneId } from '../../../domain/ids';

const pane = (tmuxId: PaneId, groupId: GroupId | null, groupPos?: number) =>
  ({ tmuxId, groupId, groupPos }) as unknown as TmuxPane;

describe('pane group order', () => {
  it('follows pane-id number when nobody has reordered the group', () => {
    const groups = buildGroupsFromPanes([
      pane(pid('%12'), gid('g1')),
      pane(pid('%3'), gid('g1')),
      pane(pid('%7'), gid('g1')),
    ]);
    expect(groups[gid('g1')].paneIds).toEqual([pid('%3'), pid('%7'), pid('%12')]);
  });

  it('follows @tmuxy-group-pos once set, and a member without one comes after', () => {
    const groups = buildGroupsFromPanes([
      pane(pid('%3'), gid('g1'), 2),
      pane(pid('%7'), gid('g1'), 0),
      pane(pid('%12'), gid('g1'), 1),
      pane(pid('%2'), gid('g1')),
    ]);
    expect(groups[gid('g1')].paneIds).toEqual([pid('%7'), pid('%12'), pid('%3'), pid('%2')]);
  });

  it('a lone tagged pane is not a group', () => {
    expect(buildGroupsFromPanes([pane(pid('%3'), gid('g1'), 0), pane(pid('%4'), null)])).toEqual(
      {},
    );
  });
});
