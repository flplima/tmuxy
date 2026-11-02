/**
 * Test fixtures for driving the app machine with a client model: panes,
 * windows and the TMUX_MODEL_UPDATE that carries them.
 */

import type { TmuxPane, TmuxWindow } from '../domain/client';
import type { PaneId, WindowId } from '../domain/ids';
import type { TmuxClientModel, TmuxSnapshot } from '../domain/store/types';

/** A pane of `windowId`, `width`×`height` cells at the window's origin. */
export const modelPane = (
  tmuxId: PaneId,
  windowId: WindowId,
  overrides: Partial<TmuxPane> = {},
): TmuxPane => ({
  id: Number(tmuxId.slice(1)),
  tmuxId,
  windowId,
  content: [],
  cursorX: 0,
  cursorY: 0,
  width: 80,
  height: 24,
  x: 0,
  y: 0,
  active: false,
  command: 'bash',
  title: '',
  borderTitle: '',
  groupId: null,
  groupPos: null,
  inMode: false,
  copyCursorX: 0,
  copyCursorY: 0,
  alternateOn: false,
  mouseAnyFlag: false,
  paused: false,
  historySize: 0,
  selectionPresent: false,
  selectionStartX: 0,
  selectionStartY: 0,
  cursorShape: 0,
  cursorHidden: false,
  ...overrides,
});

/** A window of `windowType` (a tab unless said otherwise). */
export const modelWindow = (
  id: WindowId,
  index: number,
  overrides: Partial<TmuxWindow> = {},
): TmuxWindow => ({
  id,
  index,
  name: `w${index}`,
  active: false,
  windowType: 'tab',
  floatParent: null,
  floatWidth: null,
  floatHeight: null,
  floatDrawer: null,
  floatBg: null,
  floatNoheader: false,
  ...overrides,
});

/** A model update carrying `panes` and `windows`, with nothing optimistic in flight. */
export const modelUpdate = (
  panes: TmuxPane[],
  windows: TmuxWindow[],
  active: { paneId: PaneId; windowId: WindowId },
) => {
  const activePane = panes.find((p) => p.tmuxId === active.paneId);
  const snapshot: TmuxSnapshot = {
    panes,
    windows,
    activePaneId: active.paneId,
    activeWindowId: active.windowId,
    totalWidth: activePane?.width ?? 80,
    totalHeight: activePane?.height ?? 24,
    sessionName: 'main',
    focusRequest: '',
  };
  const model: TmuxClientModel = {
    committed: snapshot,
    ops: [],
    derived: snapshot,
    paneKeyOverrides: {},
  };
  return { type: 'TMUX_MODEL_UPDATE' as const, model };
};
