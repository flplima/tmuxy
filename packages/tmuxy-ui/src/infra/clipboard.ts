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

/**
 * Put text that is still being worked out on the clipboard, from inside the
 * click that asked for it. Safari, the Mac app and the Linux app (all WebKit)
 * take a write only while that click is fresh, and refused one made once
 * tmux had answered a question ("Clipboard write failed"). A `ClipboardItem`
 * takes its text as a promise: the write is asked for at once, inside the
 * click, and filled in when the text comes. Without one, the text is written
 * once it is known. Resolves whether the write took, and never rejects.
 */
export function writeClipboardWhenKnown(
  text: Promise<string>,
  paneId: PaneId | null,
): Promise<boolean> {
  const failed = (err: unknown) => {
    logFailure('clipboard', err);
    return false;
  };
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === 'undefined') {
    return text.then((known) => writeClipboard(known, paneId), failed);
  }
  const blob = text.then((known) => {
    keepLastCopy(known, paneId);
    return new Blob([known], { type: 'text/plain' });
  });
  return clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(() => true, failed);
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
 * What the status line says when the browser refused a write. Firefox and
 * Safari take a clipboard write only while a key press or a click is still
 * fresh, so one that arrives on its own is turned down there; a page served
 * without https off localhost has no clipboard at all. Saying "Copied" then
 * is how a user pastes something else. With `willRetry` the text is kept for
 * the next key or click (`copyOnNextGesture`), and the message says so.
 */
export function clipboardBlockedMessage(
  text: string,
  paneId: PaneId | null,
  willRetry = false,
): string {
  const chars = text.length === 1 ? '1 char' : `${text.length} chars`;
  const who = paneId ? `Pane ${paneId} could not copy ${chars}` : `Could not copy ${chars}`;
  if (!hasClipboard()) return `${who}: no clipboard without https or localhost`;
  return willRetry
    ? `${who}: press a key or click to copy`
    : `${who}: the browser wants a key or a click first`;
}

function hasClipboard(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
}

interface PendingCopy {
  text: string;
  paneId: PaneId | null;
  say: (message: string) => void;
}

/** The copy a program asked for that the browser refused, until the user's next key or click. */
let pending: PendingCopy | null = null;

/**
 * The events a browser lets a page write the clipboard from (the HTML spec's
 * activation-triggering events): a key, a mouse press, a finger lifted. A
 * finger landing is not one (`pointerdown` from a touch): iOS refused the
 * write made from it.
 */
const GESTURES = ['keydown', 'mousedown', 'pointerup', 'touchend'] as const;

function waitForGesture(copy: PendingCopy): void {
  pending = copy;
  for (const type of GESTURES) window.addEventListener(type, finishPendingCopy, true);
}

function finishPendingCopy(): void {
  const waiting = pending;
  forgetPendingCopy();
  if (!waiting) return;
  const { text, paneId, say } = waiting;
  void writeClipboard(text, paneId).then((copied) => {
    if (copied) {
      say(clipboardWriteMessage(text, paneId));
      return;
    }
    // A gesture the browser did not count: the next one may be. A newer
    // request that came meanwhile is the one that waits.
    if (!pending) waitForGesture(waiting);
  });
}

function forgetPendingCopy(): void {
  pending = null;
  if (typeof window === 'undefined') return;
  for (const type of GESTURES) window.removeEventListener(type, finishPendingCopy, true);
}

/**
 * Copy text a program asked for on its own (OSC 52) and say what happened.
 *
 * A write the browser refuses for want of a recent key or click is kept and
 * made on the next one, once: the key or click is the gesture the browser
 * wanted. A newer request replaces the one waiting, and a write that takes
 * clears it. Resolves whether the first attempt took.
 */
export function copyForProgram(
  text: string,
  paneId: PaneId | null,
  say: (message: string) => void,
): Promise<boolean> {
  return writeClipboard(text, paneId).then((copied) => {
    forgetPendingCopy();
    if (copied) {
      say(clipboardWriteMessage(text, paneId));
      return true;
    }
    const willRetry = hasClipboard() && typeof window !== 'undefined';
    if (willRetry) waitForGesture({ text, paneId, say });
    say(clipboardBlockedMessage(text, paneId, willRetry));
    return false;
  });
}
