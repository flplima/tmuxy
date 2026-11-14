import { assign, cancel, raise } from 'xstate';
import { act, assignCtx } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import { STATUS_MESSAGE_DURATION, STATUS_MESSAGE_CLEAR_ID } from '../helpers';

const utf8 = new TextEncoder();

function escapeDoubleQuotedTemplateArg(value: string): string {
  let out = '';
  let first = true;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (first && ch === '~') {
      out += '\\176';
    } else if (ch === '"' || ch === '\\' || ch === '$' || ch === '`') {
      out += '\\' + ch;
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      for (const byte of utf8.encode(ch)) {
        out += '\\' + byte.toString(8).padStart(3, '0');
      }
    } else {
      out += ch;
    }
    first = false;
  }
  return out;
}

/**
 * A prompt's template with what was typed put in, the way tmux's own
 * command-prompt does it: `%%%` takes the text escaped for a double-quoted
 * word (`"`, `\`, `$`, `` ` ``, leading `~`, and C0/DEL/C1 controls), so a tab
 * named `it's "x"` or `~work` stays a literal name on a single line; `%%`
 * takes it as typed.
 */
export function fillTemplate(template: string, value: string): string {
  const escaped = escapeDoubleQuotedTemplateArg(value);
  return template
    .split('%%%')
    .map((part) => part.split('%%').join(value))
    .join(escaped);
}

export const commandUiActions = {
  /**
   * Open a pane's rename field in its header — from the header's own menu or
   * from the pane content's right-click menu, which is the same field.
   */
  commandUi_renamePane: assignCtx(({ event }) =>
    event.type === 'RENAME_PANE' ? { renamingPaneId: event.paneId } : {},
  ),

  /** The field closed: retitled (a title), or left as it was (null). */
  commandUi_renamePaneCommit: act(({ event, enqueue }) => {
    if (event.type !== 'RENAME_PANE_COMMIT') return;
    enqueue(assign({ renamingPaneId: null }));
    if (!event.title) return;
    enqueue.raise({
      type: 'DISPATCH_OP',
      op: TmuxOp.SetPaneTitle({ paneId: event.paneId, title: event.title }),
    });
  }),

  commandUi_setPrefixActive: assignCtx(({ event }) => {
    if (event.type !== 'PREFIX_MODE_CHANGE') return {};
    return {
      prefixActive: event.active,
      prefixRepeatOnly: event.active ? (event.repeatOnly ?? null) : null,
    };
  }),

  commandUi_setKeyTable: assignCtx(({ event }) => {
    if (event.type !== 'KEY_TABLE_CHANGE') return {};
    return { keyTable: event.table };
  }),

  commandUi_toggleKeysView: assignCtx(({ context }) => ({
    keysViewOpen: !context.keysViewOpen,
  })),

  commandUi_holdClose: assignCtx(({ event }) => {
    if (event.type !== 'REQUEST_CLOSE_CONFIRM') return {};
    return { pendingClose: event.pending };
  }),

  commandUi_dropPendingClose: assignCtx(() => ({ pendingClose: null })),

  commandUi_openCommandPrompt: act(({ event, context, enqueue }) => {
    if (event.type !== 'OPEN_COMMAND_PROMPT') return;
    const windowName = context.windows.find((w) => w.id === context.activeWindowId)?.name ?? '';
    const expand = (text: string) =>
      text.replace(/#W/g, () => windowName).replace(/#S/g, () => context.sessionName);
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

  commandUi_submitCommandMode: act(({ event, context, enqueue }) => {
    if (event.type !== 'COMMAND_MODE_SUBMIT') return;
    const mode = context.commandMode;
    if (!mode) return;

    const finalCommand = mode.template ? fillTemplate(mode.template, event.value) : event.value;

    enqueue(assign({ commandMode: null }));

    if (!finalCommand.trim()) return;

    // The same path as a key binding or a menu item (../dispatch.ts): the
    // intercepts and the store's optimistic prediction.
    enqueue(raise({ type: 'SEND_TMUX_COMMAND', command: finalCommand }));
  }),

  commandUi_cancelCommandMode: assignCtx({
    commandMode: null,
  }),

  commandUi_showStatusMessage: act(({ event, enqueue }) => {
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

  commandUi_clearStatusMessage: assignCtx({
    statusMessage: null,
  }),
};
