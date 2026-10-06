/**
 * How a pane snapshot is reconciled with the client's copy-mode record.
 *
 * The one ordering that matters is a race nothing but a slow machine shows:
 * the client closes a record and sends `-X cancel`, then opens a new one
 * before tmux has confirmed the cancel. The next snapshot reports the PREVIOUS
 * exit. It must not close the new record.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { pid } from '../../../../test/wire';
import { COPY_MODE_REENTRY_COOLDOWN, copyModeExitTimes, reconcilePaneMode } from '../copyMode';

const pane = (inMode: boolean) => ({ tmuxId: pid('%1'), inMode });
const live = { readOnly: false, now: 100_000 };

afterEach(() => copyModeExitTimes.clear());

describe('reconcilePaneMode', () => {
  /** The race itself, in the order the snapshots arrive. */
  it('a snapshot reporting the previous exit does not close a record tmux has not been seen in', () => {
    // The client opened the record itself; tmux has not confirmed it yet.
    const fresh = { tmuxSeen: undefined };
    // prev: tmux was still in the OLD copy mode when the last snapshot was
    // taken. new: the cancel from the old record's exit has now landed.
    expect(reconcilePaneMode(pane(true), pane(false), fresh, live)).toBe('none');
  });

  it('the first snapshot showing the mode on confirms a record the client opened', () => {
    expect(reconcilePaneMode(pane(false), pane(true), { tmuxSeen: undefined }, live)).toBe(
      'confirm',
    );
    // And a confirmed record needs nothing more from a snapshot still showing it on.
    expect(reconcilePaneMode(pane(true), pane(true), { tmuxSeen: true }, live)).toBe('none');
  });

  it('tmux leaving a copy mode it was seen in closes the record', () => {
    expect(reconcilePaneMode(pane(true), pane(false), { tmuxSeen: true }, live)).toBe('leave');
  });

  /** The yank flow: tmux has already left, the view stays for the copy flash. */
  it('a record on its way out after a copy is left to close itself', () => {
    expect(
      reconcilePaneMode(pane(true), pane(false), { tmuxSeen: true, copiedAt: 99_000 }, live),
    ).toBe('none');
  });

  /** The scroll view never asks tmux for a mode, so tmux can never end it. */
  it('a record tmux was never seen in is never closed by tmux', () => {
    expect(reconcilePaneMode(pane(true), pane(false), {}, live)).toBe('none');
    expect(reconcilePaneMode(pane(false), pane(false), {}, live)).toBe('none');
  });

  describe('tmux entering on its own', () => {
    it('opens a record when the client has none', () => {
      expect(reconcilePaneMode(pane(false), pane(true), undefined, live)).toBe('enter');
      expect(reconcilePaneMode(undefined, pane(true), undefined, live)).toBe('enter');
    });

    /** The same stale report in the other direction: the mode still showing on just after the client left it. */
    it('is ignored inside the cooldown after the client exited', () => {
      copyModeExitTimes.set(pid('%1'), live.now - COPY_MODE_REENTRY_COOLDOWN + 1);
      expect(reconcilePaneMode(pane(false), pane(true), undefined, live)).toBe('none');
      copyModeExitTimes.set(pid('%1'), live.now - COPY_MODE_REENTRY_COOLDOWN);
      expect(reconcilePaneMode(pane(false), pane(true), undefined, live)).toBe('enter');
    });

    it('is not an entry when the mode was already on', () => {
      expect(reconcilePaneMode(pane(true), pane(true), undefined, live)).toBe('none');
    });

    it('never happens for a read-only viewer', () => {
      expect(
        reconcilePaneMode(pane(false), pane(true), undefined, { ...live, readOnly: true }),
      ).toBe('none');
    });
  });
});
