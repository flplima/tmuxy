import { describe, it, expect, vi } from 'vitest';
import { activeCloseTarget, executeMenuAction } from '../menuActions';
import type { AppMachineEvent } from '../../../machines/types';

describe('activeCloseTarget', () => {
  it('prefers the focused float pane', () => {
    expect(activeCloseTarget('%3', '%9')).toBe('%9');
  });

  it('falls back to the real active pane when no float is focused', () => {
    expect(activeCloseTarget('%3', null)).toBe('%3');
  });

  it('ignores an optimistic placeholder active pane', () => {
    expect(activeCloseTarget('__placeholder_5', null)).toBeUndefined();
  });

  it('returns undefined when there is no active pane', () => {
    expect(activeCloseTarget(null, null)).toBeUndefined();
  });
});

describe('executeMenuAction pane-close routing', () => {
  it('routes to group-aware CLOSE_PANE when a target pane is known', () => {
    const sent: AppMachineEvent[] = [];
    const send = (e: AppMachineEvent) => sent.push(e);
    executeMenuAction(send, 'pane-close', '%7');
    expect(sent).toEqual([{ type: 'CLOSE_PANE', paneId: '%7' }]);
  });

  it('falls back to raw kill-pane when no target pane is known', () => {
    const send = vi.fn();
    executeMenuAction(send, 'pane-close');
    expect(send).toHaveBeenCalledWith({ type: 'SEND_COMMAND', command: 'kill-pane' });
  });
});
