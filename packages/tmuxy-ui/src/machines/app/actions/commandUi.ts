/**
 * Action implementations for the commandUi parallel state.
 *
 * Owns commandMode, statusMessage, statusLine, prefixActive.
 * Helpers (parseCommandPrompt, parseDisplayMessage, STATUS_MESSAGE_DURATION)
 * live in ../helpers.ts and are shared with the layout state's
 * SEND_TMUX_COMMAND interception logic.
 */

import { assign, cancel, enqueueActions, raise, sendTo } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../../types';
import {
  parseCommandPrompt,
  parseDisplayMessage,
  STATUS_MESSAGE_DURATION,
  STATUS_MESSAGE_CLEAR_ID,
} from '../helpers';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

export const commandUiActions = {
  commandUi_setPrefixActive: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'PREFIX_MODE_CHANGE') return {};
    return { prefixActive: event.active };
  }),

  commandUi_submitCommandMode: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, context, enqueue }) => {
    if (event.type !== 'COMMAND_MODE_SUBMIT') return;
    const mode = context.commandMode;
    if (!mode) return;

    const finalCommand = mode.template ? mode.template.replace(/%%/g, event.value) : event.value;

    enqueue(assign({ commandMode: null }));

    if (!finalCommand.trim()) return;

    if (finalCommand.match(/^display-message\b/)) {
      const msg = parseDisplayMessage(finalCommand);
      if (msg !== null) {
        enqueue(assign({ statusMessage: { text: msg, timestamp: Date.now() } }));
        enqueue(cancel(STATUS_MESSAGE_CLEAR_ID));
        enqueue(
          raise(
            { type: 'CLEAR_STATUS_MESSAGE' },
            { delay: STATUS_MESSAGE_DURATION, id: STATUS_MESSAGE_CLEAR_ID },
          ),
        );
        return;
      }
    }

    if (finalCommand.match(/^command-prompt\b/)) {
      const parsed = parseCommandPrompt(finalCommand, context);
      enqueue(
        assign({
          commandMode: {
            prompt: parsed.prompt,
            input: parsed.initialValue,
            template: parsed.template,
          },
        }),
      );
      return;
    }

    // Through the STORE so typed commands (rename-window from the tab-rename
    // prompt, kill-*, splits entered via `:`) get their optimistic
    // predictions; unrecognized commands pass through as RawCommand exactly
    // as before.
    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_COMMAND' as const,
        command: finalCommand,
      }),
    );
  }),

  commandUi_cancelCommandMode: assign<Ctx, Evt, undefined, Evt, never>({
    commandMode: null,
  }),

  commandUi_showStatusMessage: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, enqueue }) => {
    if (event.type !== 'SHOW_STATUS_MESSAGE') return;
    enqueue(
      assign({
        statusMessage: { text: event.text, timestamp: Date.now() },
      }),
    );
    enqueue(cancel(STATUS_MESSAGE_CLEAR_ID));
    enqueue(
      raise(
        { type: 'CLEAR_STATUS_MESSAGE' },
        { delay: STATUS_MESSAGE_DURATION, id: STATUS_MESSAGE_CLEAR_ID },
      ),
    );
  }),

  // The delayed CLEAR_STATUS_MESSAGE raise is cancelled and re-scheduled by id
  // whenever a new message is shown, so whatever reaches here is the current
  // message's own expiry — no timestamp guard needed.
  commandUi_clearStatusMessage: assign<Ctx, Evt, undefined, Evt, never>({
    statusMessage: null,
  }),
};
