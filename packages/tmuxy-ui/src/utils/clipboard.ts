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
