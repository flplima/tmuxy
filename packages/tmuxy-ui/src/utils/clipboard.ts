/**
 * Put text on the system clipboard from inside the app.
 *
 * Fire-and-forget: a denied permission must not break whatever copied. The
 * last payload is also kept on `window.__tmuxyLastClipboard`, so a test can
 * see what was copied without reading the system clipboard (which needs a
 * permission a headless browser does not grant).
 */
export function writeClipboard(text: string, paneId: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch((err) => {
      console.warn('[clipboard] write rejected:', err);
    });
  }
  const win = globalThis as unknown as {
    __tmuxyLastClipboard?: { paneId: string; text: string };
  };
  win.__tmuxyLastClipboard = { paneId, text };
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
export function clipboardWriteMessage(text: string, paneId: string): string {
  const chars = text.length === 1 ? '1 char' : `${text.length} chars`;
  return paneId ? `Copied ${chars} from pane ${paneId}` : `Copied ${chars}`;
}
