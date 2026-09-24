/**
 * The desktop app's OS windows, as the Window menu and its shortcuts see them.
 *
 * Several GUI windows can be open on one tmux session: each is its own client on
 * its own session in a tmux session group, so they share every tab and pane but
 * each keeps its own current tab (see `tmuxy-tauri-app/src/windows.rs`). Only the
 * desktop app has OS windows to manage, so every call here is a no-op in a
 * browser tab — the web build's one window is the browser's business.
 */

import { isTauri } from '../tmux/adapters';

/** One row of the Window menu. */
export interface GuiWindowInfo {
  /** 1-based position, and the digit that focuses this window. */
  index: number;
  /** The window's own title, as macOS lists it. */
  title: string;
  focused: boolean;
}

/** The iTerm2 window styles, by the slug the backend names them with. */
export const WINDOW_STYLES = [
  { slug: 'normal', label: 'Normal' },
  { slug: 'full-screen', label: 'Full Screen' },
  { slug: 'maximized', label: 'Maximized' },
  { slug: 'no-title-bar', label: 'No Title Bar' },
  { slug: 'full-width-top', label: 'Full-Width Top of Screen' },
  { slug: 'full-width-bottom', label: 'Full-Width Bottom of Screen' },
  { slug: 'full-height-left', label: 'Full-Height Left of Screen' },
  { slug: 'full-height-right', label: 'Full-Height Right of Screen' },
  { slug: 'top', label: 'Top of Screen' },
  { slug: 'bottom', label: 'Bottom of Screen' },
  { slug: 'left', label: 'Left of Screen' },
  { slug: 'right', label: 'Right of Screen' },
] as const;

export type WindowStyleSlug = (typeof WINDOW_STYLES)[number]['slug'];

/**
 * Call a desktop-only command, or resolve to `fallback` in a browser.
 *
 * A failed call is logged rather than thrown: these are menu actions and
 * keystrokes, and neither has anywhere to put a rejected promise.
 */
async function desktop<T>(cmd: string, fallback: T, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return fallback;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (e: unknown) {
    console.error(`${cmd} failed:`, e);
    return fallback;
  }
}

/** Open another GUI window on the same session group. */
export function newGuiWindow(): void {
  void desktop('new_window', undefined);
}

/** Bring the window at `index` to the front. */
export function focusGuiWindow(index: number): void {
  void desktop('focus_window', undefined, { index });
}

/** Every open GUI window, in menu order; empty in a browser. */
export function listGuiWindows(): Promise<GuiWindowInfo[]> {
  return desktop<GuiWindowInfo[]>('list_gui_windows', []);
}

/** Put this window into one of the window styles. */
export function setWindowStyle(style: WindowStyleSlug): void {
  void desktop('set_window_style', undefined, { style });
}

/** The style this window is in — `normal` in a browser, which has no styles. */
export function getWindowStyle(): Promise<WindowStyleSlug> {
  return desktop<WindowStyleSlug>('get_window_style', 'normal');
}
