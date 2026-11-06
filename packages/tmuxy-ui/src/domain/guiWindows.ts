/**
 * The desktop app's OS windows and their styles, as the backend names them
 * (`tmuxy-tauri-app/src/windows.rs`, `window_style.rs`): what the Window
 * menu lists. The calls are `infra/guiWindows.ts`.
 */

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
