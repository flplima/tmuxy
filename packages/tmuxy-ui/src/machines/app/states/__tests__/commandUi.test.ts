import { describe, it, expect, vi, afterEach } from 'vitest';
import { commandUiState } from '../commandUi';
import { commandUiActions } from '../../actions/commandUi';
const commandUiGuards = {};
import { mountState, sendAndGetContext } from './testHarness';
import { STATUS_MESSAGE_DURATION } from '../../helpers';

describe('commandUi state', () => {
  it('PREFIX_MODE_CHANGE toggles prefixActive', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards, {
      prefixActive: false,
    });
    let ctx = sendAndGetContext(actor, { type: 'PREFIX_MODE_CHANGE', active: true });
    expect(ctx.prefixActive).toBe(true);
    ctx = sendAndGetContext(actor, { type: 'PREFIX_MODE_CHANGE', active: false });
    expect(ctx.prefixActive).toBe(false);
  });

  it('COMMAND_MODE_CANCEL clears commandMode', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards, {
      commandMode: { prompt: ':', input: 'whatever', template: null },
    });
    const ctx = sendAndGetContext(actor, { type: 'COMMAND_MODE_CANCEL' });
    expect(ctx.commandMode).toBeNull();
  });

  // The submitted command takes the same path as a key binding: it is raised
  // as SEND_TMUX_COMMAND, whose handler owns every intercept.
  function mountRecordingSubmits(template: string | null) {
    const sent: string[] = [];
    const actor = mountState(
      { on: { ...commandUiState.on, SEND_TMUX_COMMAND: { actions: 'recordCommand' } } },
      {
        ...commandUiActions,
        recordCommand: ({ event }: { event: { command: string } }) => {
          sent.push(event.command);
        },
      },
      commandUiGuards,
      { commandMode: { prompt: ':', input: '', template } },
    );
    return { actor, sent };
  }

  it('COMMAND_MODE_SUBMIT clears commandMode and raises the typed command', () => {
    const { actor, sent } = mountRecordingSubmits(null);
    const ctx = sendAndGetContext(actor, { type: 'COMMAND_MODE_SUBMIT', value: 'new-window' });
    expect(ctx.commandMode).toBeNull();
    expect(sent).toEqual(['new-window']);
  });

  it('COMMAND_MODE_SUBMIT substitutes %% in the template with the typed value', () => {
    // The template drives the real tab-rename prompt (command-prompt -p ...
    // "rename-window '%%'").
    const { actor, sent } = mountRecordingSubmits("rename-window -- '%%'");
    const ctx = sendAndGetContext(actor, { type: 'COMMAND_MODE_SUBMIT', value: 'build' });
    expect(ctx.commandMode).toBeNull();
    expect(sent).toEqual(["rename-window -- 'build'"]);
  });

  it('COMMAND_MODE_SUBMIT sends nothing for a blank command', () => {
    const { actor, sent } = mountRecordingSubmits(null);
    const ctx = sendAndGetContext(actor, { type: 'COMMAND_MODE_SUBMIT', value: '   ' });
    expect(ctx.commandMode).toBeNull();
    expect(sent).toEqual([]);
  });

  it('SHOW_STATUS_MESSAGE sets the message text', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards);
    const ctx = sendAndGetContext(actor, { type: 'SHOW_STATUS_MESSAGE', text: 'saved' });
    expect(ctx.statusMessage?.text).toBe('saved');
  });

  it('CLEAR_STATUS_MESSAGE clears the message', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards, {
      statusMessage: { text: 'anything', timestamp: Date.now() },
    });
    const ctx = sendAndGetContext(actor, { type: 'CLEAR_STATUS_MESSAGE' });
    expect(ctx.statusMessage).toBeNull();
  });

  describe('status message auto-clear (delayed raise)', () => {
    afterEach(() => vi.useRealTimers());

    it('auto-clears the status message after STATUS_MESSAGE_DURATION', () => {
      vi.useFakeTimers();
      const actor = mountState(commandUiState, commandUiActions, commandUiGuards);
      actor.send({ type: 'SHOW_STATUS_MESSAGE', text: 'saved' });
      expect(actor.getSnapshot().context.statusMessage?.text).toBe('saved');
      vi.advanceTimersByTime(STATUS_MESSAGE_DURATION);
      expect(actor.getSnapshot().context.statusMessage).toBeNull();
    });

    it('re-showing a message restarts the window instead of clearing the newer one early', () => {
      vi.useFakeTimers();
      const actor = mountState(commandUiState, commandUiActions, commandUiGuards);
      actor.send({ type: 'SHOW_STATUS_MESSAGE', text: 'first' });
      // Just before the first message's timer fires, show a second one — this
      // cancels the first's delayed clear and schedules a fresh one.
      vi.advanceTimersByTime(STATUS_MESSAGE_DURATION - 1000);
      actor.send({ type: 'SHOW_STATUS_MESSAGE', text: 'second' });
      // Past when the first would have expired: the second must still be shown.
      vi.advanceTimersByTime(1000);
      expect(actor.getSnapshot().context.statusMessage?.text).toBe('second');
      // A full window after the second message: now it clears.
      vi.advanceTimersByTime(STATUS_MESSAGE_DURATION - 1000);
      expect(actor.getSnapshot().context.statusMessage).toBeNull();
    });
  });
});
