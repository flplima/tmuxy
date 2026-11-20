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
  keepLastCopy(text, paneId);
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

function keepLastCopy(text: string, paneId: PaneId | null): void {
  const win = globalThis as unknown as {
    __tmuxyLastClipboard?: { paneId: PaneId | null; text: string };
  };
  win.__tmuxyLastClipboard = { paneId, text };
}

/** What a copy the user made says: how many characters went. */
export function copiedMessage(text: string): string {
  const count = [...text].length;
  return `Copied ${count} character${count === 1 ? '' : 's'}`;
}

/** A notice a copy raises: the app's `NOTIFY`, without its type. */
export interface CopyNotice {
  kind?: 'info';
  text: string;
}

/**
 * Copy text the user asked to copy, and say so: the one path for a selection
 * copied by a release, a key or a button.
 *
 * The copy command first, filled from its own copy event: inside the key or
 * click that asked for it, it is the write every browser takes. Without one
 * (no command, or the browser ran none) the clipboard API is asked, and what
 * is said waits for its answer: "Copied" over a write that was refused is how
 * a user pastes something else. Resolves whether the copy took.
 */
export function copyAndSay(
  text: string,
  paneId: PaneId | null,
  say: (notice: CopyNotice) => void,
): Promise<boolean> {
  if (copyByCommand(text)) {
    keepLastCopy(text, paneId);
    say({ kind: 'info', text: copiedMessage(text) });
    return Promise.resolve(true);
  }
  return writeClipboard(text, paneId).then((wrote) => {
    say(
      wrote
        ? { kind: 'info', text: copiedMessage(text) }
        : { text: clipboardBlockedMessage(text, null) },
    );
    return wrote;
  });
}

/**
 * `document.execCommand('copy')` with `text` set on the copy event it fires.
 * True only when the browser ran the command and the event carried the text:
 * outside a key or a click, Firefox and Safari run none.
 */
function copyByCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  let filled = false;
  const fill = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
    filled = true;
  };
  window.addEventListener('copy', fill, true);
  try {
    return document.execCommand('copy') && filled;
  } catch (err) {
    logFailure('clipboard', err);
    return false;
  } finally {
    window.removeEventListener('copy', fill, true);
  }
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
