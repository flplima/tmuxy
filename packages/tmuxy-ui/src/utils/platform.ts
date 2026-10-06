/** Whether this is an Apple platform, where Cmd is the modifier Ctrl is elsewhere. */
export function isMacPlatform(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
  );
}

/**
 * The URL of `path` on one of the desktop app's own schemes (registered in
 * `tmuxy-tauri-app/src/gui.rs`). Windows serves custom schemes over
 * http://<scheme>.localhost; the other platforms tmuxy ships a desktop build
 * for use the scheme directly.
 */
export function tauriSchemeUrl(scheme: string, path: string): string {
  const base = navigator.userAgent.includes('Windows')
    ? `http://${scheme}.localhost`
    : `${scheme}://localhost`;
  return `${base}${path}`;
}
