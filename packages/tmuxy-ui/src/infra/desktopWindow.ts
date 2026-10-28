/**
 * Desktop (Tauri) window chrome behind the status bar, which doubles as the
 * window's title bar: dragging, the title-bar double-click gesture, and — on
 * macOS — keeping the native traffic-light buttons centred on the bar as its
 * height follows the font size. The Rust side lives in
 * `tmuxy-tauri-app/src/titlebar.rs`.
 *
 * Each title-bar action is traced (docs/TRACING.md) under an `action_id`
 * that the Rust side echoes on its own events, so `tmuxy trace` joins the
 * client invoke to the native outcome (zoom state, button geometry).
 */

import { isMacPlatform, isTauri } from '../utils/platform';
import { tracer } from './tracer';

export const isMacTauri = isTauri() && isMacPlatform();

/** Per-page-load prefix so ids stay unique across app restarts in one trace file. */
const actionPrefix = `titlebar-${Date.now().toString(36)}`;
let actionCounter = 0;

/** Invoke a window command, tracing it under a fresh `action_id`. */
async function invoke<T = void>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const actionId = tracer.isEnabled() ? `${actionPrefix}-${++actionCounter}` : undefined;
  tracer.event({
    layer: 'tauri',
    component: 'desktopWindow',
    name: cmd,
    action_id: actionId,
    ...args,
  });
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, { ...args, actionId });
}

/** Hand the current mousedown to the OS as a window drag. */
export function startWindowDrag(): void {
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
    getCurrentWindow().startDragging(),
  );
}

/** The native title-bar double-click (zoom / minimize per OS preference). */
export function titlebarDoubleClick(): void {
  void invoke('titlebar_double_click');
}

/**
 * Report the status bar's rendered height to the desktop shell whenever it
 * changes so the traffic lights stay on its midline. Callback ref: returns the
 * observer's disposer, which React runs when the element unmounts.
 */
export function reportTitlebarHeight(bar: HTMLElement | null): (() => void) | undefined {
  if (!bar || !isMacTauri) return undefined;
  const observer = new ResizeObserver(() => {
    void invoke('set_titlebar_height', { height: bar.getBoundingClientRect().height });
  });
  observer.observe(bar);
  return () => observer.disconnect();
}

/** How far each sidebar has widened the window: what closing it takes back. */
const sidebarGrowth = { left: 0, right: 0 };

/**
 * A sidebar beside a grid `@tmuxy-size` fixes: widen the window by the
 * column as it opens and narrow it back as it closes, so the pane area keeps
 * its size. The shell grows the window only as far as the screen allows (and
 * not at all when it is maximized or fullscreen); the grid is fitted to
 * whatever room is left, and closing gives back only what opening took.
 */
export function fitWindowToSidebar(side: 'left' | 'right', open: boolean, widthPx: number): void {
  if (!isTauri()) return;
  const dx = open ? widthPx - sidebarGrowth[side] : -sidebarGrowth[side];
  if (!open) sidebarGrowth[side] = 0;
  if (dx === 0) return;
  void invoke<number>('grow_window', { dx }).then((applied) => {
    if (open) sidebarGrowth[side] += applied;
  });
}
