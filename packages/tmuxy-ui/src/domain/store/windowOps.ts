import { type TmuxSnapshot, type Patch, type ReconcileVerdict, lingerVerdict } from './types';
import type { TmuxPane, TmuxWindow } from '../client';
import type { TmuxOpOf, WindowTag } from '../commands';
import {
  isPlaceholderId,
  placeholderPaneId as newPlaceholderPaneId,
  placeholderWindowId as newPlaceholderWindowId,
  type PaneId,
  type WindowId,
} from '../ids';
import type { PredictContext, PredictResult } from './predict';
import { makePlaceholderPane } from './paneOps';
import { selectWindowTarget, stripTabs } from '../windows';

export function predictNewWindow(
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
  opId: string,
): PredictResult {
  const maxIndex = snapshot.windows.reduce((m, w) => Math.max(m, w.index), -1);
  const placeholderWindowId = newPlaceholderWindowId(opId);
  const placeholderPaneId = newPlaceholderPaneId(`pane_${opId}`);
  const placeholderWindow: TmuxWindow = {
    id: placeholderWindowId,
    index: maxIndex + 1,
    name: `Window ${maxIndex + 1}`,
    active: true,
    windowType: 'tab',
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
    zoomed: false,
  };
  let cols = snapshot.totalWidth;
  let rows = snapshot.totalHeight;
  if (cols <= 0 || rows <= 0) {
    const activeWindow = snapshot.windows.find((w) => w.id === snapshot.activeWindowId);
    const sibling = snapshot.panes.find((p) => p.windowId === activeWindow?.id);
    if (sibling) {
      cols = sibling.x + sibling.width;
      rows = sibling.y + sibling.height;
    }
  }
  const placeholderPane: TmuxPane = makePlaceholderPane(
    placeholderPaneId,
    placeholderWindowId,
    ctx.defaultShell,
    { x: 0, y: 0, width: cols, height: rows },
  );

  const priorWindowIds = snapshot.windows.map((w) => w.id);

  const patch: Patch = (s) => {
    // Must mirror reconcileNewWindow's match condition exactly: `break-pane`
    // sets the window's `@tmuxy-window-type` tag a beat BEFORE the moved pane's
    // window_id settles, so a tab-typed but paneless newborn would render as a
    // second tab beside the placeholder. A pane can even arrive a snapshot
    // before its window record.
    const isRenderableTab = (w: TmuxWindow): boolean =>
      w.windowType === 'tab' && s.panes.some((p) => p.windowId === w.id);
    const unclaimedNewborns = new Set(
      s.windows
        .filter(
          (w) => !priorWindowIds.includes(w.id) && !isPlaceholderId(w.id) && !isRenderableTab(w),
        )
        .map((w) => w.id),
    );
    const knownWindowIds = new Set(s.windows.map((w) => w.id));
    const isNewbornPane = (p: TmuxPane): boolean => {
      if (priorWindowIds.includes(p.windowId)) return false;
      if (p.windowId === placeholderWindowId || isPlaceholderId(p.windowId)) return false;
      return unclaimedNewborns.has(p.windowId) || !knownWindowIds.has(p.windowId);
    };
    const windows = s.windows.filter((w) => !unclaimedNewborns.has(w.id));
    const panes = s.panes.filter((p) => !isNewbornPane(p));
    return {
      ...s,
      windows: [...windows.map((w) => ({ ...w, active: false })), placeholderWindow],
      panes: [...panes, placeholderPane],
      activeWindowId: placeholderWindowId,
      activePaneId: placeholderPaneId,
    };
  };

  return {
    patch,
    meta: { placeholderWindowId, placeholderPaneId, priorWindowIds },
  };
}

export function reconcileNewWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
  panes: ReadonlyArray<TmuxPane>,
  claimedRealIds: ReadonlySet<PaneId | WindowId>,
): ReconcileVerdict {
  const prior = new Set(meta.priorWindowIds as WindowId[]);
  if (windows.length === 0) return { _tag: 'pending' };
  const candidate = windows.find(
    (w) =>
      !prior.has(w.id) &&
      !isPlaceholderId(w.id) &&
      !claimedRealIds.has(w.id) &&
      w.windowType === 'tab' &&
      // break-pane emits %window-add (and the type tag) a beat before the
      // moved pane's window_id settles; matched on the bare window, the pane-key
      // override has no pane to map and the real pane remounts (a flicker).
      panes.some((p) => p.windowId === w.id),
  );
  if (candidate) return { _tag: 'matched', realWindowId: candidate.id };
  return { _tag: 'pending' };
}

export function predictSelectWindow(
  op: TmuxOpOf<'SelectWindow'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  if (!snapshot.activeWindowId) return null;
  const target = selectWindowTarget(op.target, snapshot.windows, snapshot.activeWindowId);
  if (!target) return null;

  const targetId = target.id;
  // The tab strip reads the per-window `active` flag, so it flips in the same
  // patch. The active pane is derived inside the patch, from the snapshot it is
  // replayed onto: a background window can arrive pane-less on some
  // transports, and the switch must stay pinned until its panes land.
  const patch: Patch = (s) => {
    if (!s.windows.some((w) => w.id === targetId)) return s;
    const targetPanes = s.panes.filter((p) => p.windowId === targetId);
    // The window's own active pane first: `pane.active` is session-wide, so
    // a background tab's panes never carry it.
    const ownActive = s.windows.find((w) => w.id === targetId)?.activePaneId;
    const activeInTarget =
      targetPanes.find((p) => p.tmuxId === ownActive) ??
      targetPanes.find((p) => p.active) ??
      targetPanes[0];
    return {
      ...s,
      windows: s.windows.map((w) => ({ ...w, active: w.id === targetId })),
      activeWindowId: targetId,
      activePaneId: activeInTarget?.tmuxId ?? s.activePaneId,
    };
  };

  return {
    patch,
    meta: {
      targetWindowId: targetId,
      previousActiveWindowId: snapshot.activeWindowId,
    },
  };
}

export function reconcileSelectWindow(
  meta: Readonly<Record<string, unknown>>,
  serverActiveWindowId: WindowId | null,
  ageMs: number,
  committedWindows?: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const target = meta.targetWindowId as WindowId;
  const previous = meta.previousActiveWindowId as WindowId | null | undefined;
  if (committedWindows && !committedWindows.some((w) => w.id === target)) {
    return { _tag: 'matched' };
  }
  return lingerVerdict(target, previous, serverActiveWindowId, ageMs);
}

export function predictKillWindow(
  op: TmuxOpOf<'KillWindow'>,
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
): PredictResult | null {
  const windowId = op.windowId ?? snapshot.activeWindowId;
  if (!windowId || isPlaceholderId(windowId)) return null;
  const doomed = snapshot.windows.find((w) => w.id === windowId);
  if (!doomed) return null;

  // tmux makes the last window used current (its `lastw` stack), else the
  // previous one, else the next. The last used is the tab of the most recently
  // active pane outside the doomed one; the reconciler only requires the
  // window to be gone, so a different server choice self-corrects on confirm.
  // Worked out from the state the patch lands on: a rebase replays it over a
  // newer state, whose current tab may not be the one seen at predict time.
  const nextActive = (s: TmuxSnapshot): TmuxWindow | null => {
    const tabs = stripTabs(s.windows).filter((w) => w.id !== windowId);
    const sorted = [...tabs].sort((a, b) => a.index - b.index);
    const lastUsed = ctx.paneActivationOrder
      .map((id) => s.panes.find((p) => p.tmuxId === id)?.windowId)
      .map((id) => tabs.find((w) => w.id === id))
      .find((w) => w !== undefined);
    return (
      lastUsed ??
      [...sorted].reverse().find((w) => w.index < doomed.index) ??
      sorted.find((w) => w.index > doomed.index) ??
      null
    );
  };

  const patch: Patch = (s) => {
    const next = s.activeWindowId === windowId ? nextActive(s) : null;
    const windows = s.windows
      .filter((w) => w.id !== windowId)
      .map((w) => (next ? { ...w, active: w.id === next.id } : w));
    const panes = s.panes.filter((p) => p.windowId !== windowId);
    if (s.activeWindowId !== windowId) return { ...s, windows, panes };
    const activeWindowId = next?.id ?? null;
    const targetPanes = panes.filter((p) => p.windowId === activeWindowId);
    const activePaneId = (targetPanes.find((p) => p.active) ?? targetPanes[0])?.tmuxId ?? null;
    return { ...s, windows, panes, activeWindowId, activePaneId };
  };

  return { patch, meta: { killedWindowId: windowId } };
}

export function reconcileKillWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const killed = meta.killedWindowId as WindowId;
  if (!windows.some((w) => w.id === killed)) return { _tag: 'matched' };
  return { _tag: 'pending' };
}

export function predictRenameWindow(
  op: TmuxOpOf<'RenameWindow'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const windowId = op.target ?? snapshot.activeWindowId;
  if (!windowId || isPlaceholderId(windowId)) return null;
  if (!snapshot.windows.some((w) => w.id === windowId)) return null;

  const patch: Patch = (s) => ({
    ...s,
    windows: s.windows.map((w) => (w.id === windowId ? { ...w, name: op.name } : w)),
  });
  return { patch, meta: { renamedWindowId: windowId, newName: op.name } };
}

export function reconcileRenameWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const windowId = meta.renamedWindowId as WindowId;
  const name = meta.newName as string;
  const window = windows.find((w) => w.id === windowId);
  if (!window) return { _tag: 'matched' };
  if (window.name === name) return { _tag: 'matched' };
  return { _tag: 'pending' };
}

/**
 * A sidebar column shut or shown (`@tmuxy-sidebar-hidden`), or a float
 * minimized or brought back (`@tmuxy-float-minimized`), is the client's
 * own say until tmux has had time to answer it. The echo of an earlier
 * write of this client's, or a state tmux computed before the write, can
 * arrive after it (a dock, then a shut, then the dock's late echo): read as
 * news, it would show again a column the user had just shut. The flag is
 * held, as a focus pin is, until the server has kept it for the linger.
 * The other tags this client writes size panes the server re-tiles, and
 * have no flag on the model to predict.
 */
/** The window flags a tag sets, by tag: the ones the client predicts. */
const FLAG_OF: Partial<Record<WindowTag, 'sidebarHidden' | 'floatMinimized'>> = {
  'sidebar-hidden': 'sidebarHidden',
  'float-minimized': 'floatMinimized',
};

export function predictWindowTag(
  op: TmuxOpOf<'SetWindowTag'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const flag = FLAG_OF[op.tag];
  if (!flag || isPlaceholderId(op.windowId)) return null;
  const window = snapshot.windows.find((w) => w.id === op.windowId);
  if (!window) return null;
  const hidden = op.value !== null;
  const patch: Patch = (s) => ({
    ...s,
    windows: s.windows.map((w) => (w.id === op.windowId ? { ...w, [flag]: hidden } : w)),
  });
  return {
    patch,
    meta: { windowId: op.windowId, flag, hidden, wasHidden: Boolean(window[flag]) },
  };
}

export function reconcileWindowTag(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
  ageMs: number,
): ReconcileVerdict {
  if (meta.windowId === undefined) return { _tag: 'matched' };
  const window = windows.find((w) => w.id === meta.windowId);
  if (!window) return { _tag: 'matched' };
  return lingerVerdict(
    meta.hidden as boolean,
    meta.wasHidden as boolean,
    Boolean(window[meta.flag as 'sidebarHidden' | 'floatMinimized']),
    ageMs,
  );
}

/**
 * A dragged tab is already where the pointer left it when the drop commits,
 * so the strip must not jump back to the old order while `move-window`
 * travels: the windows are reordered here, keeping their index numbers in
 * strip order (`renumber-windows` is what tmux will do), and held until the
 * server's order agrees.
 */
export function predictMoveWindow(
  op: TmuxOpOf<'MoveWindow'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  if (isPlaceholderId(op.windowId) || isPlaceholderId(op.anchorId)) return null;
  if (op.windowId === op.anchorId) return null;
  const moving = snapshot.windows.find((w) => w.id === op.windowId);
  if (!moving || !snapshot.windows.some((w) => w.id === op.anchorId)) return null;

  const patch: Patch = (s) => {
    const rest = s.windows.filter((w) => w.id !== op.windowId);
    const anchorAt = rest.findIndex((w) => w.id === op.anchorId);
    if (anchorAt === -1) return s;
    const at = op.placement === 'before' ? anchorAt : anchorAt + 1;
    const ordered = [...rest.slice(0, at), moving, ...rest.slice(at)];
    const indices = s.windows.map((w) => w.index).sort((a, b) => a - b);
    return { ...s, windows: ordered.map((w, i) => ({ ...w, index: indices[i] })) };
  };
  return {
    patch,
    meta: { movedWindowId: op.windowId, anchorId: op.anchorId, placement: op.placement },
  };
}

export function reconcileMoveWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const moved = windows.findIndex((w) => w.id === meta.movedWindowId);
  const anchor = windows.findIndex((w) => w.id === meta.anchorId);
  if (moved === -1 || anchor === -1) return { _tag: 'matched' };
  const landed = meta.placement === 'before' ? moved + 1 === anchor : anchor + 1 === moved;
  return landed ? { _tag: 'matched' } : { _tag: 'pending' };
}

/**
 * A pane-group tab click: the clicked (parked) member takes the visible
 * member's window and geometry, and the visible one parks in the clicked
 * one's old window — what the pane-group switch script does
 * (resize-window ; swap-pane).
 */
export function predictGroupSwitch(
  op: TmuxOpOf<'GroupSwitch'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const clicked = snapshot.panes.find((p) => p.tmuxId === op.clickedPaneId);
  const visible = snapshot.panes.find((p) => p.tmuxId === op.visiblePaneId);
  if (!clicked || !visible || clicked.tmuxId === visible.tmuxId) return null;

  const clickedId = op.clickedPaneId;
  const visibleId = visible.tmuxId;
  const visibleSlot = {
    windowId: visible.windowId,
    x: visible.x,
    y: visible.y,
    width: visible.width,
    height: visible.height,
  };
  const parkedWindowId = clicked.windowId;

  const patch: Patch = (s) => {
    const hasClicked = s.panes.some((p) => p.tmuxId === clickedId);
    const hasVisible = s.panes.some((p) => p.tmuxId === visibleId);
    if (!hasClicked || !hasVisible) return s;
    return {
      ...s,
      panes: s.panes.map((p) => {
        if (p.tmuxId === clickedId) return { ...p, ...visibleSlot, active: true };
        if (p.tmuxId === visibleId) return { ...p, windowId: parkedWindowId, active: false };
        return p;
      }),
      activePaneId: clickedId,
    };
  };

  return {
    patch,
    meta: {
      clickedPaneId: clickedId,
      visiblePaneId: visibleId,
      visibleWindowId: visibleSlot.windowId,
    },
  };
}

export function reconcileGroupSwitch(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
  serverActivePaneId: PaneId | null,
  ageMs: number,
): ReconcileVerdict {
  const clickedId = meta.clickedPaneId as PaneId;
  const visibleId = meta.visiblePaneId as PaneId;
  const clicked = panes.find((p) => p.tmuxId === clickedId);
  const visible = panes.find((p) => p.tmuxId === visibleId);
  if (!clicked || !visible) {
    // A pane of the swap is gone: release quietly rather than surface a
    // phantom rollback error.
    return { _tag: 'matched' };
  }
  return lingerVerdict(clickedId, visibleId, serverActivePaneId, ageMs);
}
