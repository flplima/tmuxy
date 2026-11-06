import type { TmuxPane, TmuxWindow } from '../domain/client';
import type { CellLine } from '../domain/wireCells';
import type { PaneId, WindowId } from '../domain/ids';
import { recomputeDerived } from '../domain/store/model';
import {
  EMPTY_SNAPSHOT,
  type PendingOp,
  type TmuxClientModel,
  type TmuxSnapshot,
} from '../domain/store/types';

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

/**
 * A model update carrying `panes` and `windows`, sized to the active pane,
 * with `ops` in flight (none unless given).
 */
export const modelUpdate = (
  panes: TmuxPane[],
  windows: TmuxWindow[],
  active: { paneId: PaneId | null; windowId: WindowId },
  extra: { ops?: PendingOp[]; sessionName?: string } = {},
) => {
  const activePane = panes.find((p) => p.tmuxId === active.paneId);
  const snapshot: TmuxSnapshot = {
    panes,
    windows,
    activePaneId: active.paneId,
    activeWindowId: active.windowId,
    totalWidth: activePane?.width ?? 80,
    totalHeight: activePane?.height ?? 24,
    sessionName: extra.sessionName ?? 'main',
    focusRequest: '',
    pluginsRev: '',
    themeRev: '',
  };
  const model: TmuxClientModel = {
    committed: snapshot,
    ops: extra.ops ?? [],
    derived: snapshot,
    paneKeyOverrides: {},
  };
  return { type: 'TMUX_MODEL_UPDATE' as const, model };
};

/** The `sidebars` field with the named columns open (and nothing starting). */
export const sidebarsOpen = (open: { left?: boolean; right?: boolean }) => ({
  left: { open: open.left ?? false, starting: false, startFailed: false },
  right: { open: open.right ?? false, starting: false, startFailed: false },
});

/** A model holding `snapshot` as committed, with no op pending. */
export function modelFromSnapshot(snapshot: TmuxSnapshot): TmuxClientModel {
  return recomputeDerived({
    committed: snapshot,
    ops: [],
    derived: EMPTY_SNAPSHOT,
    paneKeyOverrides: {},
  });
}

/** A row of cells reading `text`, one character a cell. */
export const cellLine = (text: string): CellLine => [...text].map((c) => ({ c }));
