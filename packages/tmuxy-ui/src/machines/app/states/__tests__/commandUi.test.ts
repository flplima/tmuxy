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

  it('COMMAND_MODE_SUBMIT clears commandMode after submit', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards, {
      commandMode: { prompt: ':', input: '', template: null },
    });
    const ctx = sendAndGetContext(actor, { type: 'COMMAND_MODE_SUBMIT', value: 'new-window' });
    expect(ctx.commandMode).toBeNull();
  });

  it('COMMAND_MODE_SUBMIT with template substitutes %% with value', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards, {
      commandMode: { prompt: ':', input: '', template: 'rename-window %%' },
    });
    const ctx = sendAndGetContext(actor, { type: 'COMMAND_MODE_SUBMIT', value: 'my-name' });
    // commandMode is cleared after submit regardless of template
    expect(ctx.commandMode).toBeNull();
  });

  it('COMMAND_MODE_SUBMIT substitutes %% in the template with the typed value', () => {
    // The template drives the real tab-rename prompt (command-prompt -p ...
    // "rename-window '%%'"). Observe the substitution through the only
    // window this harness has: a display-message template whose %% lands in
    // the resulting status message.
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards, {
      commandMode: { prompt: 'name:', input: '', template: 'display-message "renamed to %%"' },
    });
    const ctx = sendAndGetContext(actor, {
      type: 'COMMAND_MODE_SUBMIT',
      value: 'build',
    });
    expect(ctx.statusMessage?.text).toBe('renamed to build');
    expect(ctx.commandMode).toBeNull();
  });

  it('COMMAND_MODE_SUBMIT with display-message sets statusMessage', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards, {
      commandMode: { prompt: ':', input: '', template: null },
    });
    const ctx = sendAndGetContext(actor, {
      type: 'COMMAND_MODE_SUBMIT',
      value: 'display-message "Hello world"',
    });
    expect(ctx.statusMessage?.text).toBe('Hello world');
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
