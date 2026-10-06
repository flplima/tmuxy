/**
 * Action implementations for the commandUi slice (a root-level `on` block).
 *
 * Owns commandMode, statusMessage, prefixActive.
 *
 * A submitted command is raised as SEND_TMUX_COMMAND: it is a string the
 * user typed, parsed and routed like a binding (see ../dispatch.ts).
 */

import { assign, cancel, enqueueActions, raise } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../../types';
import { STATUS_MESSAGE_DURATION, STATUS_MESSAGE_CLEAR_ID } from '../helpers';
import { READ_ONLY_NOTICE } from '../../../tmux/readOnly';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

export const commandUiActions = {
  commandUi_setPrefixActive: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'PREFIX_MODE_CHANGE') return {};
    return { prefixActive: event.active };
  }),

  commandUi_openCommandPrompt: enqueueActions<
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
    if (event.type !== 'OPEN_COMMAND_PROMPT') return;
    if (context.readOnly) {
      enqueue.raise({ type: 'NOTIFY', text: READ_ONLY_NOTICE });
      return;
    }
    const windowName = context.windows.find((w) => w.id === context.activeWindowId)?.name ?? '';
    const expand = (text: string) =>
      text.replace(/#W/g, windowName).replace(/#S/g, context.sessionName);
    enqueue(
      assign({
        commandMode: {
          prompt: expand(event.prompt ?? ':'),
          input: expand(event.initial),
          template: event.template,
        },
      }),
    );
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

    // The same path as a key binding or a menu item: the intercepts
    // (copy-mode, nested command-prompt, display-message, tab/group nav)
    // and the store's optimistic prediction.
    enqueue(raise({ type: 'SEND_TMUX_COMMAND', command: finalCommand }));
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
