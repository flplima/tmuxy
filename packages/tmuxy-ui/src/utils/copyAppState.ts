/**
 * Debug > Copy App State: the client's view of the session as JSON on the
 * clipboard — windows (index, id, name, type, active pane), panes (id,
 * window, geometry, active), the active ids and the sidebar state — so a
 * "which pane did the client think this was" question can be answered from
 * the production app, which has no console.
 */

import type { AppMachineContext } from '../machines/types';

export function appStateSummary(ctx: AppMachineContext): Record<string, unknown> {
  return {
    sessionName: ctx.sessionName,
    activeWindowId: ctx.activeWindowId,
    activePaneId: ctx.activePaneId,
    windows: ctx.windows.map((w) => ({
      index: w.index,
      id: w.id,
      name: w.name,
      type: w.windowType,
      active: w.active,
      activePaneId: w.activePaneId ?? null,
    })),
    panes: ctx.panes.map((p) => ({
      id: p.tmuxId,
      windowId: p.windowId,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      active: p.active,
      command: p.command,
    })),
    lastActivePaneByWindow: ctx.lastActivePaneByWindow,
    sidebars: {
      leftOpen: ctx.leftSidebarOpen,
      leftFocused: ctx.leftSidebarFocused,
      rightOpen: ctx.rightSidebarOpen,
      rightFocused: ctx.rightSidebarFocused,
    },
    focusedFloatPaneId: ctx.focusedFloatPaneId,
    tabOverviewOpen: ctx.tabOverviewOpen,
  };
}

/** Where a clipboard write's outcome goes: status line on success, snackbar on failure. */
export interface ClipboardReport {
  onCopied: (text: string) => void;
  onFailed: (text: string) => void;
}

export function copyAppState(ctx: AppMachineContext, report: ClipboardReport): void {
  const text = JSON.stringify(appStateSummary(ctx), null, 2);
  navigator.clipboard.writeText(text).then(
    () => report.onCopied('Copied app state'),
    (e: unknown) => report.onFailed(`Clipboard write failed: ${String(e)}`),
  );
}
