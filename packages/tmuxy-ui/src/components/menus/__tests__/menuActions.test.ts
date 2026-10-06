import { describe, it, expect, vi } from 'vitest';
import { placeholderPaneId } from '../../../domain/ids';
import { pid } from '../../../test/wire';
import { activeCloseTarget, executeMenuAction } from '../menuActions';
import type { AppMachineEvent } from '../../../machines/types';

describe('activeCloseTarget', () => {
  it('prefers the focused float pane', () => {
    expect(activeCloseTarget(pid('%3'), pid('%9'))).toBe(pid('%9'));
  });

  it('falls back to the real active pane when no float is focused', () => {
    expect(activeCloseTarget(pid('%3'), null)).toBe(pid('%3'));
  });

  it('ignores an optimistic placeholder active pane', () => {
    expect(activeCloseTarget(placeholderPaneId('5'), null)).toBeUndefined();
  });

  it('returns undefined when there is no active pane', () => {
    expect(activeCloseTarget(null, null)).toBeUndefined();
  });
});

describe('executeMenuAction pane-close routing', () => {
  it('routes to group-aware CLOSE_PANE when a target pane is known', () => {
    const sent: AppMachineEvent[] = [];
    const send = (e: AppMachineEvent) => sent.push(e);
    executeMenuAction(send, 'pane-close', pid('%7'));
    expect(sent).toEqual([{ type: 'CLOSE_PANE', paneId: pid('%7') }]);
  });

  it('falls back to raw kill-pane when no target pane is known', () => {
    const send = vi.fn();
    executeMenuAction(send, 'pane-close');
    expect(send).toHaveBeenCalledWith({ type: 'SEND_TMUX_COMMAND', command: 'kill-pane' });
  });

  it('opens github URL for help-github', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    executeMenuAction(vi.fn(), 'help-github');
    expect(openSpy).toHaveBeenCalledWith('https://github.com/flplima/tmuxy', '_blank');
    openSpy.mockRestore();
  });

  it('opens bug report URL for help-report-bug', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    executeMenuAction(vi.fn(), 'help-report-bug');
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/flplima/tmuxy/issues/new?template=bug.yml',
      '_blank',
    );
    openSpy.mockRestore();
  });
});
