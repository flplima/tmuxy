import { describe, expect, it } from 'vitest';
import {
  PANE_STATES,
  PANE_STATE_TIER,
  aggregatePaneState,
  isNoteworthy,
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

describe('isNoteworthy', () => {
  it('draws everything except the quiet default', () => {
    expect(isNoteworthy('idle')).toBe(false);
    expect(isNoteworthy('working')).toBe(true);
    expect(isNoteworthy('needs-input')).toBe(true);
  });
});
