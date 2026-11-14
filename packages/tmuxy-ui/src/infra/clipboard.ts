import type { PaneId } from '../domain/ids';
import { logFailure } from './logFailure';

/**
 * Put text on the system clipboard from inside the app: the one place every
 * copy goes through.
 *
 * Resolves whether the write took, and never rejects: a denied permission
 * must not break whatever copied, and is logged here. The last payload is
 * also kept on `window.__tmuxyLastClipboard`, so a test can see what was
 * copied without reading the system clipboard (which needs a permission a
 * headless browser does not grant).
 */
export function writeClipboard(text: string, paneId: PaneId | null): Promise<boolean> {
  const win = globalThis as unknown as {
    __tmuxyLastClipboard?: { paneId: PaneId | null; text: string };
  };
  win.__tmuxyLastClipboard = { paneId, text };
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return Promise.resolve(false);
  }
  return navigator.clipboard.writeText(text).then(
    () => true,
    (err: unknown) => {
      logFailure('clipboard', err);
      return false;
    },
  );
}

/**
 * What the status line says when a pane replaced the system clipboard.
 *
 * OSC 52 arrives in pane OUTPUT, so a file a user merely `cat`s can carry it.
 * The write itself is legitimate and common (an nvim or tmux yank over ssh is
 * the reason the sequence is honoured at all), so this announces it rather
 * than asking about it — a confirmation dialog on every yank would be worse
 * than the risk. The pane is named because a write the user did not make is
 * the one worth noticing.
 */
export function clipboardWriteMessage(text: string, paneId: PaneId | null): string {
  const chars = text.length === 1 ? '1 char' : `${text.length} chars`;
  return paneId ? `Copied ${chars} from pane ${paneId}` : `Copied ${chars}`;
}

/**
 * What the status line says when the browser refused a pane's write. Firefox
 * and Safari take a clipboard write only while a key press or a click is
 * still fresh, so an OSC 52 that arrives on its own (a command that copies
 * its result when it ends) is turned down there; a page served without https
 * off localhost has no clipboard at all. Saying "Copied" then is how a user
 * pastes something else.
 */
export function clipboardBlockedMessage(text: string, paneId: PaneId | null): string {
  const chars = text.length === 1 ? '1 char' : `${text.length} chars`;
  const who = paneId ? `Pane ${paneId} could not copy ${chars}` : `Could not copy ${chars}`;
  const hasClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
  return hasClipboard
    ? `${who}: the browser wants a key or a click first`
    : `${who}: no clipboard without https or localhost`;
}
