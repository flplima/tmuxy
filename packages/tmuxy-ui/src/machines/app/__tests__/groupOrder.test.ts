import { describe, expect, it } from 'vitest';
import { buildGroupsFromPanes } from '../helpers';
import type { TmuxPane } from '../../../tmux/types';

const pane = (tmuxId: string, groupId: string | null, groupPos?: number) =>
  ({ tmuxId, groupId, groupPos }) as unknown as TmuxPane;

describe('pane group order', () => {
  it('follows pane-id number when nobody has reordered the group', () => {
    const groups = buildGroupsFromPanes([pane('%12', 'g1'), pane('%3', 'g1'), pane('%7', 'g1')]);
    expect(groups.g1.paneIds).toEqual(['%3', '%7', '%12']);
  });

  it('follows @tmuxy-group-pos once set, and a member without one comes after', () => {
    const groups = buildGroupsFromPanes([
      pane('%3', 'g1', 2),
      pane('%7', 'g1', 0),
      pane('%12', 'g1', 1),
      pane('%2', 'g1'),
    ]);
    expect(groups.g1.paneIds).toEqual(['%7', '%12', '%3', '%2']);
  });

  it('a lone tagged pane is not a group', () => {
    expect(buildGroupsFromPanes([pane('%3', 'g1', 0), pane('%4', null)])).toEqual({});
  });
});
