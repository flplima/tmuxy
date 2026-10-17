import { describe, expect, it } from 'vitest';
import { pid, wid } from '../../test/wire';
import {
  PANE_STATES,
  PANE_STATE_TIER,
  aggregatePaneState,
  circledNumber,
  nextUnreadPaneIds,
  tabPaneStates,
  normalizePaneState,
  paneStateFor,
  type PaneStateName,
} from '../paneState';

describe('normalizePaneState', () => {
  it('takes every state in the vocabulary', () => {
    for (const state of PANE_STATES) {
      expect(normalizePaneState(state)).toBe(state);
    }
  });

  it('collapses an unknown value to idle rather than erroring', () => {
    // The hook contract is deliberately loose: an agent may write a status
    // tmuxy has never heard of, and that must not break the tree.
    expect(normalizePaneState('queued-sandbox-creation')).toBe('idle');
    expect(normalizePaneState('WAITING_FOR_THE_MOON')).toBe('idle');
  });

  it('treats an unset or blank option as idle', () => {
    expect(normalizePaneState(undefined)).toBe('idle');
    expect(normalizePaneState(null)).toBe('idle');
    expect(normalizePaneState('   ')).toBe('idle');
  });

  it('forgives the spellings a shell writer reaches for', () => {
    expect(normalizePaneState('  WORKING \n')).toBe('working');
    expect(normalizePaneState('needs_input')).toBe('needs-input');
    expect(normalizePaneState('needs input')).toBe('needs-input');
    expect(normalizePaneState('needsinput')).toBe('needs-input');
  });
});

describe('paneStateFor', () => {
  it('reports what the pane declared', () => {
    expect(paneStateFor({ paneState: 'working' })).toBe('working');
    // Failure is declared too, not derived from an exit status.
    expect(paneStateFor({ paneState: 'error' })).toBe('error');
  });

  it('is idle for a pane that never declared anything', () => {
    expect(paneStateFor({ paneState: null })).toBe('idle');
    expect(paneStateFor({ paneState: undefined })).toBe('idle');
  });

  it('lets a pending question outrank whatever the pane declared', () => {
    // A pane asking whether to allow a send IS waiting on the user, whatever
    // it last said about itself — and the tree has to point at the tab holding it.
    const asking = btoa(JSON.stringify({ token: 't', caller: 'claude', keys: ['ls'] }));
    expect(paneStateFor({ paneState: 'working', paneAsk: asking })).toBe('needs-input');
    expect(paneStateFor({ paneState: 'idle', paneAsk: asking })).toBe('needs-input');
    // An unreadable option is not a question: it must not pin a pane to
    // needs-input with no overlay to explain why.
    expect(paneStateFor({ paneState: 'working', paneAsk: 'garbage' })).toBe('working');
  });
});

describe('aggregatePaneState', () => {
  const roll = (...states: PaneStateName[]) => aggregatePaneState(states);

  it('answers idle for a tab with no panes', () => {
    expect(roll()).toBe('idle');
  });

  it('surfaces the question over the failure', () => {
    // A tab holding both a blocked agent and a failed command reads as
    // needs-input: the error is already over, the question still blocks.
    expect(roll('error', 'needs-input')).toBe('needs-input');
  });

  it('ranks the whole vocabulary by attention', () => {
    expect(roll('idle', 'working')).toBe('working');
    expect(roll('working', 'unread')).toBe('unread');
    expect(roll('unread', 'error')).toBe('error');
    expect(roll('idle', 'idle')).toBe('idle');
  });

  it('keeps the tier order strictly descending in urgency', () => {
    const tiers = PANE_STATES.map((s) => PANE_STATE_TIER[s]);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(new Set(tiers).size).toBe(PANE_STATES.length);
  });
});

describe('nextUnreadPaneIds', () => {
  const pane = (id: string, paneState: string | null) => ({ tmuxId: pid(id), paneState });

  it('marks a pane that finished while the user was in another one, until they look', () => {
    const working = [pane('%1', 'working'), pane('%2', null)];
    const done = [pane('%1', 'idle'), pane('%2', null)];
    const unread = nextUnreadPaneIds([], working, done, pid('%2'));
    expect(unread).toEqual([pid('%1')]);
    expect(paneStateFor(done[0], unread.includes(pid('%1')))).toBe('unread');

    // Still unread on the next update, and the same array: nothing changed.
    expect(nextUnreadPaneIds(unread, done, done, pid('%2'))).toBe(unread);
    // The user moves to it.
    expect(nextUnreadPaneIds(unread, done, done, pid('%1'))).toEqual([]);
  });

  it('leaves a pane the user is in, and one that starts working again', () => {
    const working = [pane('%1', 'needs-input')];
    expect(nextUnreadPaneIds([], working, [pane('%1', 'idle')], pid('%1'))).toEqual([]);
    expect(nextUnreadPaneIds([pid('%1')], working, [pane('%1', 'working')], null)).toEqual([]);
  });

  it('does not mark a pane that was only ever idle, or one that closed', () => {
    expect(nextUnreadPaneIds([], [pane('%1', null)], [pane('%1', 'idle')], null)).toEqual([]);
    expect(nextUnreadPaneIds([pid('%1')], [pane('%1', 'idle')], [], null)).toEqual([]);
  });
});

describe('tabPaneStates', () => {
  it('rolls each tab up to its most attention-worthy pane, a question ahead of work', () => {
    const panes = [
      { tmuxId: pid('%1'), windowId: wid('@1'), paneState: 'working' },
      { tmuxId: pid('%2'), windowId: wid('@1'), paneState: 'needs-input' },
      { tmuxId: pid('%3'), windowId: wid('@2'), paneState: 'working' },
      { tmuxId: pid('%4'), windowId: wid('@3'), paneState: null },
    ];
    const states = tabPaneStates([wid('@1'), wid('@2'), wid('@3')], panes, [pid('%4')]);
    expect(states.get(wid('@1'))).toEqual({ count: 2, state: 'needs-input' });
    expect(states.get(wid('@2'))?.state).toBe('working');
    expect(states.get(wid('@3'))?.state).toBe('unread');
  });
});

describe('circledNumber', () => {
  it('circles one to twenty, and writes the rest plainly', () => {
    expect([1, 2, 10].map(circledNumber)).toEqual(['➊', '➋', '➓']);
    expect([11, 20].map(circledNumber)).toEqual(['⓫', '⓴']);
    expect(circledNumber(21)).toBe('21');
  });
});
