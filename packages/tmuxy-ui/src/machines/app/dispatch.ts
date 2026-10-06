/**
 * The app's command entry, part of the app machine's own orchestration (it
 * hands work to several slices). A command enters the app one of two ways:
 * `DISPATCH_OP` (an op the client itself issues) or `SEND_TMUX_COMMAND` (a
 * string — a binding, what the user typed at the prompt — parsed into the op
 * it means). Both end in `routeOp`, the one routing step.
 *
 * Some ops never reach tmux — the client is the one that shows a command
 * prompt, a status message or copy mode. Tab and group navigation take the
 * optimistic paths a click takes (`SELECT_TAB`, `SELECT_PANE_GROUP_TAB`), and
 * horizontal navigation can cross into a sidebar. Everything else goes to the
 * store, which predicts it and sends it.
 */

import { assign, enqueueActions, sendTo } from 'xstate';
import { isLayoutChange, isMultiStep, TmuxOp, type TmuxOpOf } from '../../domain/commands';
import type { PaneId, WindowId } from '../../domain/ids';
import { parseCommandToOp, stripPin } from '../../tmux/store/parseCommand';
import type { AllAppMachineEvents, AppMachineContext } from '../types';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;
/** The `enqueue` an action receives (xstate does not export it). */
type Enqueue = Parameters<
  Parameters<typeof enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>>[0]
>[0]['enqueue'];

/**
 * Fill in the targets an op leaves to "tmux's current one" where the client's
 * own idea of current is the better one: tmux's current window and pane can
 * lag the user's focus (an optimistic tab switch, a control-mode client whose
 * current window drifts under `window-size manual`).
 */
function bindActiveTargets(op: TmuxOp, context: Ctx): TmuxOp {
  switch (op._tag) {
    case 'CyclePane':
      return op.windowId || !context.activeWindowId
        ? op
        : TmuxOp.CyclePane({ windowId: context.activeWindowId });
    case 'GroupAdd': {
      if (op.pane) return op;
      const pane = context.panes.find((p) => p.tmuxId === context.activePaneId);
      return pane
        ? TmuxOp.GroupAdd({
            pane: { paneId: pane.tmuxId, width: pane.width, height: pane.height },
          })
        : op;
    }
    default:
      return op;
  }
}

/**
 * The window a tab-navigation op lands on, or null when it is not one the
 * strip shows or is already the current one (so SELECT_TAB has nothing to do).
 */
function tabNavTarget(target: TmuxOpOf<'SelectWindow'>['target'], context: Ctx): WindowId | null {
  if (!context.activeWindowId) return null;
  const visible = context.windows.filter((w) => w.windowType === 'tab');
  let window;
  if (target === 'next' || target === 'previous') {
    const current = visible.findIndex((w) => w.id === context.activeWindowId);
    if (current === -1) return null;
    const step = target === 'next' ? 1 : -1;
    window = visible[(current + step + visible.length) % visible.length];
  } else if (typeof target === 'number') {
    window = visible.find((w) => w.index === target);
  } else {
    window = visible.find((w) => w.id === target);
  }
  return window && window.id !== context.activeWindowId ? window.id : null;
}

/**
 * The group member a step lands on, mirroring the shell scripts: index off
 * the member in view and step ±1 — wrapping for the group commands, stopping
 * at the ends for Ctrl+h / Ctrl+l (`wrap: false`), whose key then falls
 * through to the pane beside or the sidebar exactly as the `nav` script does.
 * Null when the focus is in no group, or the step would stay put.
 */
function groupStepTarget(direction: 'next' | 'prev', wrap: boolean, context: Ctx): PaneId | null {
  // The user's perceived focus — the optimistically-set activePaneId — so
  // back-to-back steps don't get stuck on a stale visible pane.
  const focus = context.activePaneId;
  if (!focus) return null;
  const group = Object.values(context.paneGroups).find((g) => g.paneIds.includes(focus));
  if (!group || group.paneIds.length <= 1) return null;
  const visibleId = group.paneIds.find(
    (id) => context.panes.find((p) => p.tmuxId === id)?.windowId === context.activeWindowId,
  );
  if (!visibleId) return null;
  const count = group.paneIds.length;
  let index = group.paneIds.indexOf(visibleId) + (direction === 'next' ? 1 : -1);
  if (index < 0 || index >= count) {
    if (!wrap) return null;
    index = (index + count) % count;
  }
  const target = group.paneIds[index];
  return target && target !== visibleId ? target : null;
}

/**
 * Horizontal navigation at a sidebar's boundary: out of a focused column back
 * to the panes, or from the outermost pane into an open column (instead of a
 * tmux no-op). Inside a group, the members come first. True when handled.
 */
function routeSidebarNav(direction: 'L' | 'R', context: Ctx, enqueue: Enqueue): boolean {
  // Leaving a focused column always works, even when the pane underneath
  // happens to be in a group; nav further outward has nowhere to go.
  if (context.leftSidebarFocused) {
    if (direction === 'R') enqueue.raise({ type: 'BLUR_LEFT_SIDEBAR' });
    return true;
  }
  if (context.rightSidebarFocused) {
    if (direction === 'L') enqueue.raise({ type: 'BLUR_RIGHT_SIDEBAR' });
    return true;
  }
  const member = groupStepTarget(direction === 'L' ? 'prev' : 'next', false, context);
  if (member) {
    enqueue.raise({ type: 'SELECT_PANE_GROUP_TAB', paneId: member });
    return true;
  }
  const pane = context.panes.find((p) => p.tmuxId === context.activePaneId);
  if (!pane) return false;
  if (direction === 'L' && context.leftSidebarOpen && pane.x === 0) {
    enqueue.raise({ type: 'FOCUS_LEFT_SIDEBAR' });
    return true;
  }
  if (direction === 'R' && context.rightSidebarOpen && pane.x + pane.width >= context.totalWidth) {
    enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' });
    return true;
  }
  return false;
}

/**
 * Route `op`. `wire` is the exact string to send instead of the op's own form,
 * when the op was parsed from one (a binding keeps its pin and its flags).
 */
function routeOp(op: TmuxOp, wire: string | undefined, context: Ctx, enqueue: Enqueue) {
  switch (op._tag) {
    case 'EnterCopyMode': {
      const paneId = op.paneId ?? context.activePaneId;
      if (paneId) enqueue.raise({ type: 'ENTER_COPY_MODE', paneId });
      return;
    }
    case 'CommandPrompt':
      enqueue.raise({
        type: 'OPEN_COMMAND_PROMPT',
        prompt: op.prompt,
        initial: op.initial,
        template: op.template,
      });
      return;
    case 'DisplayMessage':
      enqueue.raise({ type: 'SHOW_STATUS_MESSAGE', text: op.message });
      return;
    case 'SelectWindow': {
      // Shares the optimistic flip and lastActivePaneByWindow bookkeeping
      // with a click on the tab.
      const windowId = tabNavTarget(op.target, context);
      if (windowId) {
        enqueue.raise({ type: 'SELECT_TAB', windowId });
        return;
      }
      break;
    }
    case 'Navigate':
      if (op.script && (op.direction === 'L' || op.direction === 'R')) {
        if (routeSidebarNav(op.direction, context, enqueue)) return;
      }
      break;
    case 'GroupStep': {
      // The optimistic swap + keyboard re-target a click on the group's tab
      // gets, so `<prefix> -` and friends don't lag the visible state.
      const paneId = groupStepTarget(op.direction, true, context);
      if (paneId) {
        enqueue.raise({ type: 'SELECT_PANE_GROUP_TAB', paneId });
        return;
      }
      break;
    }
    default:
      break;
  }

  // A new window or a multi-step script settles into one delta server-side,
  // but the active-pane swap it ends with can still trigger a CSS transition;
  // the next model update re-enables animations. Splits are not suppressed:
  // PaneLayout's enter/shift lifecycle owns the split morph.
  if (isMultiStep(op)) enqueue(assign({ enableAnimations: false }));
  // Lets a re-tile's transient active-pane changes be ignored.
  if (isLayoutChange(op)) enqueue(assign({ lastLayoutCommandTime: Date.now() }));

  // The store applies the op's predicted patch synchronously (this machine
  // sees it on the next TMUX_MODEL_UPDATE), sends it, and rolls it back if the
  // send fails.
  enqueue(sendTo('tmuxStore', { type: 'DISPATCH_OP' as const, op, command: wire }));
}

/**
 * Resolve relative window targets in tmux commands.
 *
 * With window-size manual, the control mode client's "current window"
 * (referenced by "." in target specs like ":.+") can drift from the user's
 * active window. This replaces the implicit "." with the explicit window ID
 * so commands target the correct window regardless of CC client state.
 */
function resolveWindowTarget(command: string, activeWindowId: WindowId | null): string {
  if (activeWindowId && command.includes('-t :.')) {
    // Global: a compound command (e.g. `selectw -t :. ; swapw -t :.`) can carry
    // more than one relative window target — resolve every one, not just the first.
    return command.replace(/-t :\./g, `-t ${activeWindowId}.`);
  }
  return command;
}

/**
 * tmux format strings control mode will not resolve for us (a `run-shell`
 * from an expanded alias in a root binding), filled from the active pane.
 */
function expandPaneFormats(command: string, context: Ctx): string {
  if (!context.activePaneId || !/#\{pane_(id|width|height)\}/.test(command)) return command;
  const pane = context.panes.find((p) => p.tmuxId === context.activePaneId);
  let expanded = command.replace(/#{pane_id}/g, context.activePaneId);
  if (pane) {
    expanded = expanded
      .replace(/#{pane_width}/g, String(pane.width))
      .replace(/#{pane_height}/g, String(pane.height));
  }
  return expanded;
}

export const dispatchActions = {
  /** An op the client issues itself. */
  dispatch_op: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'DISPATCH_OP') return;
      routeOp(bindActiveTargets(event.op, context), undefined, context, enqueue);
    },
  ),

  /**
   * A command that arrives as a string: resolved against the client's state,
   * parsed into the op it means, and routed like any op — with the resolved
   * string, pin and flags intact, as what goes to tmux.
   */
  dispatch_command: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'SEND_TMUX_COMMAND') return;
      const command = resolveWindowTarget(
        expandPaneFormats(event.command, context),
        context.activeWindowId,
      );

      // `select-window -t <N>`: N is the visual tab position, not a tmux index
      // (chrome windows consume indices), so it names the window by ID —
      // never its index, which is stale whenever tmux has renumbered.
      const position = stripPin(command).match(/^select-window\s+-t\s+(\d+)$/);
      const positioned = position
        ? context.windows.filter((w) => w.windowType === 'tab')[Number(position[1]) - 1]
        : undefined;
      if (positioned) {
        routeOp(TmuxOp.SelectWindow({ target: positioned.id }), undefined, context, enqueue);
        return;
      }

      routeOp(parseCommandToOp(command), command, context, enqueue);
    },
  ),
};
