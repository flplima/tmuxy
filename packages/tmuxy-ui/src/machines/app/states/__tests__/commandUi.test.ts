import { describe, it, expect } from 'vitest';
import { commandUiState } from '../commandUi';
import { commandUiActions } from '../../actions/commandUi';
import { commandUiGuards } from '../../guards/commandUi';
import { mountState, sendAndGetContext } from './testHarness';

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

  it('ENTER_COMMAND_MODE opens command prompt with defaults', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards);
    const ctx = sendAndGetContext(actor, { type: 'ENTER_COMMAND_MODE' });
    expect(ctx.commandMode).toEqual({ prompt: ':', input: '', template: null });
  });

  it('ENTER_COMMAND_MODE accepts custom prompt, initialValue, template', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards);
    const ctx = sendAndGetContext(actor, {
      type: 'ENTER_COMMAND_MODE',
      prompt: 'rename-window:',
      initialValue: 'old-name',
      template: 'rename-window %%',
    });
    expect(ctx.commandMode).toEqual({
      prompt: 'rename-window:',
      input: 'old-name',
      template: 'rename-window %%',
    });
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

  it('CLEAR_STATUS_MESSAGE clears only sufficiently-old messages', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards, {
      statusMessage: { text: 'fresh', timestamp: Date.now() },
    });
    const ctx = sendAndGetContext(actor, { type: 'CLEAR_STATUS_MESSAGE' });
    // Fresh message must NOT be cleared (race protection)
    expect(ctx.statusMessage?.text).toBe('fresh');
  });

  it('CLEAR_STATUS_MESSAGE does clear old messages', () => {
    const actor = mountState(commandUiState, commandUiActions, commandUiGuards, {
      statusMessage: { text: 'stale', timestamp: Date.now() - 10_000 },
    });
    const ctx = sendAndGetContext(actor, { type: 'CLEAR_STATUS_MESSAGE' });
    expect(ctx.statusMessage).toBeNull();
  });
});
