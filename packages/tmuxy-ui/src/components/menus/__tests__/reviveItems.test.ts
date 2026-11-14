import { describe, expect, it } from 'vitest';
import { reviveItems } from '../useReviveItems';
import { reviveCheckQuery } from '../../../domain/commandHelpers';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

const pane = PaneId.make('%7');

describe('the pane menu offers Revive Agent Session', () => {
  it('only when revive itself said ok', () => {
    expect(reviveItems(pane, 'ok\n')).toEqual([
      {
        kind: 'item',
        id: 'pane-revive',
        label: 'Revive Agent Session',
        icon: 'restart',
        action: { kind: 'op', op: TmuxOp.ReviveAgent({ paneId: pane }) },
      },
    ]);
    for (const refused of [
      null,
      '',
      "%7's shell still has jobs (vim): revive would kill them",
      '%7 has no agent session to resume',
      'okay',
    ]) {
      expect(reviveItems(pane, refused)).toEqual([]);
    }
  });

  it('asks and runs the same bundled script, which runs tmuxy agent revive', () => {
    expect(toTmuxCommand(TmuxOp.CheckRevive({ paneId: pane }))).toBe(
      'run-shell "$TMUXY_DATA_DIR/bin/tmuxy/agent-revive --mark %7"',
    );
    expect(reviveCheckQuery(pane)).toBe('show-options -pqv -t %7 @tmuxy-revivable');
    expect(toTmuxCommand(TmuxOp.ReviveAgent({ paneId: pane }))).toBe(
      'run-shell "$TMUXY_DATA_DIR/bin/tmuxy/agent-revive %7"',
    );
  });
});
