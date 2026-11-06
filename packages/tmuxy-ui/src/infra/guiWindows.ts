/**
 * The desktop app's OS windows, as the Window menu and its shortcuts see them.
 *
 * Several GUI windows can be open on one tmux session: each is its own client on
 * its own session in a tmux session group, so they share every tab and pane but
 * each keeps its own current tab (see `tmuxy-tauri-app/src/windows.rs`). Only the
 * desktop app has OS windows to manage, so every call here is a no-op in a
 * browser tab — the web build's one window is the browser's business.
 */

import { isTauri } from './platform';
import { desktopCall } from './desktop';
import type { GuiWindowInfo, WindowStyleSlug } from '../domain/guiWindows';

/** Open another GUI window on the same session group. */
export function newGuiWindow(): void {
  void desktopCall('new_window', undefined);
}

/** Bring the window at `index` to the front. */
export function focusGuiWindow(index: number): void {
  void desktopCall('focus_window', undefined, { index });
}

/** Every open GUI window, in menu order; empty in a browser. */
export function listGuiWindows(): Promise<GuiWindowInfo[]> {
  return desktopCall<GuiWindowInfo[]>('list_gui_windows', []);
}

/** Close this OS window (Window ▸ Close Window). */
export function closeGuiWindow(): void {
  void desktopCall('close_window', undefined);
}

/** Leave the desktop app; tmux keeps every session. */
export function quitApp(): void {
  void desktopCall('quit_app', undefined);
}

/** Put this window into one of the window styles. */
export function setWindowStyle(style: WindowStyleSlug): void {
  void desktopCall('set_window_style', undefined, { style });
}

/** The style this window is in — `normal` in a browser, which has no styles. */
export function getWindowStyle(): Promise<WindowStyleSlug> {
  return desktopCall<WindowStyleSlug>('get_window_style', 'normal');
}

/**
 * Debug ▸ Restart App: relaunch the desktop process in place (tmux keeps every
 * session and the new process reattaches on start); in a browser the nearest
 * thing is a full reload.
 */
export function restartApp(): void {
  if (isTauri()) void desktopCall('restart_app', undefined);
  else window.location.reload();
}
