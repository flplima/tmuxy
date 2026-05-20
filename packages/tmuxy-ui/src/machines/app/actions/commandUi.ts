/**
 * Action implementations for the commandUi parallel state.
 *
 * Owns commandMode, statusMessage, statusLine, prefixActive.
 * Helpers (parseCommandPrompt, parseDisplayMessage, STATUS_MESSAGE_DURATION)
 * live in ../helpers.ts and are shared with the layout state's
 * SEND_TMUX_COMMAND interception logic.
 */

import { assign, enqueueActions, sendTo } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../../types';
import { parseCommandPrompt, parseDisplayMessage, STATUS_MESSAGE_DURATION } from '../helpers';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

export const commandUiActions = {
  commandUi_setPrefixActive: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'PREFIX_MODE_CHANGE') return {};
    return { prefixActive: event.active };
  }),

  commandUi_enterCommandMode: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'ENTER_COMMAND_MODE') return {};
    return {
      commandMode: {
        prompt: event.prompt ?? ':',
        input: event.initialValue ?? '',
        template: event.template ?? null,
      },
    };
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
        enqueue(({ self }) => {
          setTimeout(() => {
            self.send({ type: 'CLEAR_STATUS_MESSAGE' });
          }, STATUS_MESSAGE_DURATION);
        });
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

    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
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
    enqueue(({ self }) => {
      setTimeout(() => {
        self.send({ type: 'CLEAR_STATUS_MESSAGE' });
      }, STATUS_MESSAGE_DURATION);
    });
  }),

  commandUi_clearStatusMessage: assign<Ctx, Evt, undefined, Evt, never>(({ context }) => {
    // Only clear if the message is old enough (prevents clearing a newer message)
    if (
      context.statusMessage &&
      Date.now() - context.statusMessage.timestamp >= STATUS_MESSAGE_DURATION - 100
    ) {
      return { statusMessage: null };
    }
    return {};
  }),
};
