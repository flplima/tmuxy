/**
 * Desktop (Tauri) window chrome behind the status bar, which doubles as the
 * window's title bar: dragging, the title-bar double-click gesture, and — on
 * macOS — keeping the native traffic-light buttons centred on the bar as its
 * height follows the font size. The Rust side lives in
 * `tmuxy-tauri-app/src/titlebar.rs`.
 *
 * Each title-bar action is traced (docs/TELEMETRY.md) under an `action_id`
 * that the Rust side echoes on its own events, so `tmuxy trace` joins the
 * client invoke to the native outcome (zoom state, button geometry).
 */

import { isTauri } from './adapters';
import { tracer } from './tracer';

export const isMacTauri =
  isTauri() && typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);

/** Per-page-load prefix so ids stay unique across app restarts in one trace file. */
const actionPrefix = `titlebar-${Date.now().toString(36)}`;
let actionCounter = 0;

/** Invoke a title-bar command, tracing it under a fresh `action_id`. */
async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<void> {
  const actionId = tracer.isEnabled() ? `${actionPrefix}-${++actionCounter}` : undefined;
  tracer.event({
    layer: 'tauri',
    component: 'desktopWindow',
    name: cmd,
    action_id: actionId,
    ...args,
  });
  const core = await import('@tauri-apps/api/core');
  await core.invoke(cmd, { ...args, actionId });
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
