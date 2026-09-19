/**
 * Read-only sessions (`tmuxy server --read-only`): the client watches the
 * state stream and keeps its own tab and pane focus, and sends tmux nothing.
 *
 * The server refuses every write on its own; these helpers keep the client
 * from issuing one in the first place, so nothing is predicted that can never
 * be confirmed and no request is made only to be refused.
 */

/** The `/commands` a read-only server answers (`ClientCommand::is_read`). */
const READ_COMMANDS = new Set([
  'get_initial_state',
  'get_scrollback_cells',
  'get_theme_settings',
  'get_themes_list',
  'list_git_worktrees',
  'get_trace_settings',
]);

export function isReadCommand(cmd: string): boolean {
  return READ_COMMANDS.has(cmd);
}

/** The reason carried by the `Cancelled` a read-only adapter rejects with. */
export const READ_ONLY_REASON = 'read-only';

/** What the snackbar says when a viewer asks for a change. */
export const READ_ONLY_NOTICE = 'This session is read-only';

/**
 * Whether a refused tmux command is input rather than a request: keystrokes,
 * pasted text and forwarded mouse events all arrive as `send-keys`, a stream
 * of them, and a notice per key would bury the screen.
 */
export function isInputCommand(command: string): boolean {
  return /^(send-keys|send)\s/.test(command.trimStart());
}
