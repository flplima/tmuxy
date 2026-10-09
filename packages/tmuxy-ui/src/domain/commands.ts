/**
 * The command vocabulary: every intent the client issues to tmux, as data.
 *
 * Components, menus, hooks and machines build a `TmuxOp` and dispatch it; the
 * store predicts from it and `toTmuxCommand` turns it into the one string tmux
 * runs. This module is the only place in the UI that spells tmux syntax — its
 * verbs, flags, quoting and the paths of the bundled scripts — so a command
 * cannot drift between the menu that sends it, the binding label that names
 * it and the prediction that anticipates it.
 *
 * Strings that genuinely arrive as strings — the bindings tmux reports
 * (`list-keys`), what the user types at the command prompt, tmuxy.conf
 * aliases — are recognised by `domain/store/parseCommand.ts`, and whatever it
 * cannot name stays a `RawCommand`, sent verbatim.
 */

import { Data } from 'effect';
import { isPlaceholderId, type PaneId, type WindowId } from './ids';

/** Where the bundled scripts are installed, as tmux's `run-shell` expands it. */
export const SCRIPTS_DIR = '$HOME/.config/tmuxy/bin/tmuxy';

/** tmuxy's own config: never `~/.tmux.conf`, which belongs to the user's default server. */
export const CONFIG_FILE = '~/.config/tmuxy/tmuxy.conf';

/** The fixed window name of a sidebar column: unique, so a create can target it by name. */
export const SIDEBAR_WINDOW_NAME = { left: '__sidebar-left', right: '__sidebar-right' } as const;

/** What a sidebar column runs: the tree widget, or (`null`) the default shell. */
const SIDEBAR_RUN = { left: 'tmuxy widget tree', right: null } as const;

/** Longest literal a single `send-keys -l` carries before the text is split. */
const LITERAL_CHUNK_SIZE = 500;

/** A pane direction in tmux's own letters. */
export type PaneDirection = 'L' | 'R' | 'U' | 'D';

/** Which way a pane splits: `vertical` puts the new pane beside, `horizontal` below. */
export type SplitDirection = 'horizontal' | 'vertical';

/** A side of a pane a group member can be split in next to. */
export type Side = 'left' | 'right' | 'up' | 'down';

/** A tmuxy window option (`@tmuxy-<tag>`) the client writes. */
export type WindowTag = 'collapsible' | 'sidebar-hidden' | 'sidebar-rows' | 'sidebar-cols';

/** One step of a divider drag: grow or shrink `paneId` by `cells` toward `direction`. */
export interface ResizeStep {
  readonly paneId: PaneId;
  readonly direction: PaneDirection;
  readonly cells: number;
}

/** Where a member taken out of its group lands. */
export type LeaveDestination =
  | { readonly kind: 'tab' }
  | { readonly kind: 'beside'; readonly target: PaneId | WindowId; readonly side: Side };

/** A pane named together with its size, as the group-add script wants it. */
export interface SizedPane {
  readonly paneId: PaneId;
  readonly width: number;
  readonly height: number;
}

/** An op that names nothing beyond itself (`TmuxOp.NewWindow()`). */
type NoFields = Record<never, never>;

/**
 * Every intent the client issues, as a tagged union. A `null` target means
 * "tmux's current one" — the store and machine resolve it where the client's
 * own idea of "current" is the better one (see `routeOp`).
 */
export type TmuxOp = Data.TaggedEnum<{
  // ── Panes ──────────────────────────────────────────────
  Split: { readonly direction: SplitDirection };
  /** Focus the neighbour in `direction`: `select-pane`, or the tmuxy `nav` script. */
  Navigate: { readonly direction: PaneDirection; readonly script: boolean };
  SelectPane: { readonly paneId: PaneId };
  /** The next pane of a window, in tmux's order. */
  CyclePane: { readonly windowId: WindowId | null };
  LastPane: NoFields;
  /** `keepFocus` leaves the active pane where it was (`-d`). */
  Swap: {
    readonly sourcePaneId: PaneId;
    readonly targetPaneId: PaneId;
    readonly keepFocus: boolean;
  };
  SwapAdjacent: { readonly direction: 'U' | 'D' };
  /** Swap the current pane with tmux's marked pane. */
  SwapMarked: NoFields;
  /** Move tmux's marked pane in beside the current one. */
  JoinMarked: NoFields;
  MarkPane: { readonly marked: boolean };
  /** Move a pane out into a tab of its own. */
  BreakPane: { readonly paneId: PaneId | null };
  /** Move a pane into another tab, beside that tab's active pane. */
  JoinPane: { readonly paneId: PaneId; readonly windowId: WindowId };
  KillPane: { readonly paneId: PaneId | null };
  /** Predicts zoom-IN only (see predictZoomToggle). */
  ZoomToggle: { readonly paneId: PaneId | null };
  ResizePanes: { readonly steps: ReadonlyArray<ResizeStep> };
  SetPaneTitle: { readonly paneId: PaneId; readonly title: string };
  /** Reset the current pane's terminal and drop its history. */
  ClearPane: NoFields;
  PasteBuffer: NoFields;
  /** Key names (`C-c`, `Up`) to a pane — or, as a last resort, a session's active pane. */
  SendKeys: { readonly target: PaneId | string; readonly keys: string };
  /** Text typed literally, line by line. */
  SendText: { readonly target: PaneId | string; readonly text: string };
  /** An SGR mouse report for a mouse-tracking pane; coordinates are 1-based cells. */
  SendMouse: {
    readonly paneId: PaneId;
    readonly button: number;
    readonly x: number;
    readonly y: number;
    readonly release: boolean;
  };
  EnterCopyMode: { readonly paneId: PaneId | null };
  CancelCopyMode: { readonly paneId: PaneId };
  /**
   * Answer a `tmuxy ask` question: withdraw it, then record the answer pinned
   * to its token (so an answer to a question the asker already withdrew is not
   * read as one to whatever replaced it). One compound command, the clear
   * first: the overlay comes down the instant the user chooses.
   */
  AnswerAsk: { readonly paneId: PaneId; readonly token: string; readonly answer: string };

  // ── Windows (tabs) ─────────────────────────────────────
  NewWindow: NoFields;
  SelectWindow: {
    /** A window id (`@N`, what the client sends), a tmux index, or a neighbour. */
    readonly target: WindowId | number | 'next' | 'previous';
  };
  LastWindow: NoFields;
  /** Only `@N`-form targets are predicted. */
  KillWindow: { readonly windowId: WindowId | null };
  RenameWindow: { readonly target: WindowId | null; readonly name: string };
  /** Put a tab right before or after another one. */
  MoveWindow: {
    readonly windowId: WindowId;
    readonly anchorId: WindowId;
    readonly placement: 'before' | 'after';
  };
  /** A preset layout, or `next` / `previous` to cycle them. */
  SelectLayout: { readonly layout: string };
  /** Write (or, with `null`, unset) a tmuxy window option. */
  SetWindowTag: {
    readonly windowId: WindowId;
    readonly tag: WindowTag;
    readonly value: string | null;
  };

  // ── Pane groups ────────────────────────────────────────
  /** A new pane joins `pane`'s group (or opens one with it); `null` = tmux's current pane. */
  GroupAdd: { readonly pane: SizedPane | null };
  GroupClose: { readonly paneId: PaneId };
  /**
   * Swap a parked member into the visible slot `visiblePaneId` holds. Without
   * a visible member there is nothing to predict; the script still runs.
   */
  GroupSwitch: { readonly clickedPaneId: PaneId; readonly visiblePaneId: PaneId | null };
  /** Show the group's next/previous member (wrapping); `null` = tmux's current pane. */
  GroupStep: { readonly direction: 'next' | 'prev'; readonly paneId: PaneId | null };
  /** Move a member to `index` in its group's order. */
  GroupMove: { readonly paneId: PaneId; readonly index: number };
  /** An ungrouped pane joins `anchorPaneId`'s group, out of view, at `index`. */
  GroupJoin: { readonly paneId: PaneId; readonly anchorPaneId: PaneId; readonly index: number };
  GroupLeave: { readonly paneId: PaneId; readonly to: LeaveDestination };

  // ── Chrome windows (floats, sidebars) ──────────────────
  /** A float named `name` running `run`, created at the free window `index`. */
  OpenFloat: {
    readonly name: string;
    readonly run: string;
    readonly index: number;
    readonly splitFrom: PaneId | null;
  };
  OpenSidebar: { readonly side: 'left' | 'right'; readonly splitFrom: PaneId | null };

  // ── Sessions ───────────────────────────────────────────
  NewSession: { readonly name: string };
  KillSession: { readonly name: string | null };
  /** Move this client to another session (the desktop app's one control client). */
  SwitchClient: { readonly session: string };
  RenameSession: { readonly session: string | null; readonly name: string };
  SourceConfig: NoFields;
  /** Clear the one-shot focus request a shell helper queued. */
  ClearFocusRequest: { readonly session: string };
  /** Clear the session switch a shell helper queued. */
  ClearSwitchRequest: NoFields;

  // ── Handled by the client itself ───────────────────────
  /** Open the client's command prompt; `%%` in `template` takes what was typed. */
  CommandPrompt: {
    readonly prompt: string | null;
    readonly initial: string;
    readonly template: string | null;
  };
  /** Show a message on the status line. */
  DisplayMessage: { readonly message: string };

  /** A string the client did not originate and cannot name; sent verbatim. */
  RawCommand: { readonly command: string };
}>;

/** Constructors (`TmuxOp.Split({ direction })`) and matchers for `TmuxOp`. */
export const TmuxOp = Data.taggedEnum<TmuxOp>();

/** One op variant by tag. */
export type TmuxOpOf<T extends TmuxOp['_tag']> = Extract<TmuxOp, { readonly _tag: T }>;

// ============================================
// Quoting
// ============================================

/** Free text as one tmux argument, single-quoted (`it's` → `'it'\''s'`). */
export function quote(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/** A name used as a target: bare when it is plainly one word, quoted otherwise. */
function target(name: string): string {
  return /^[\w.@%:-]+$/.test(name) ? name : quote(name);
}

/** A bundled script, run by tmux. */
function script(name: string, ...args: Array<string | number>): string {
  return `run-shell "${[`${SCRIPTS_DIR}/${name}`, ...args].join(' ')}"`;
}

/** Commands run as one list (` \; ` between them). */
function list(commands: ReadonlyArray<string>): string {
  return commands.join(' \\; ');
}

/**
 * The command lines that type `text` into `target` literally, one per line.
 *
 * Control mode reads one command per line, so a newline inside a quoted
 * literal would end the `send-keys` there and run the rest of the text as tmux
 * commands of its own — `run-shell` included. Each line of text goes as its own
 * `send-keys -l` (split into chunks so no command line grows unbounded), with
 * an `Enter` between lines: what pasting the text into a terminal does.
 */
function literalText(to: string, text: string): string {
  const lines = text.split(/\r?\n/);
  const commands: string[] = [];
  lines.forEach((line, i) => {
    for (let j = 0; j < line.length; j += LITERAL_CHUNK_SIZE) {
      commands.push(`send-keys -t ${to} -l ${quote(line.slice(j, j + LITERAL_CHUNK_SIZE))}`);
    }
    if (i < lines.length - 1) commands.push(`send-keys -t ${to} Enter`);
  });
  return commands.join('\n');
}

/**
 * An SGR mouse report as `send-keys -H` hex bytes — the one reliable way in:
 * tmux ≥ 3.7 consumes mouse sequences pasted through a buffer, and `-l`
 * literals are format-expanded (see docs/TMUX.md).
 */
function mouseReport(op: TmuxOpOf<'SendMouse'>): string {
  const seq = `\x1b[<${op.button};${op.x};${op.y}${op.release ? 'm' : 'M'}`;
  const hex = Array.from(seq, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
  return `send-keys -t ${op.paneId} -H ${hex}`;
}

/**
 * The `split-window ; break-pane ; set-option` list that creates a chrome
 * window running `run` (the default shell when `null`) and tags it in one
 * shot — the list `bin/tmuxy/float-create` builds for a float.
 *
 * `at` names the new window: a float by its index (picked free up front —
 * `set-option -w` with no target would land on the session's CURRENT window,
 * which `break-pane -d` leaves unchanged), a sidebar by its fixed, unique name
 * (so the list never depends on the client's copy of the indices, which go
 * stale for a beat whenever a window closes). `splitFrom` is the pane to split,
 * so the new pane is born beside what the user sees rather than wherever tmux
 * happens to be; without one (or with a placeholder), tmux's current pane.
 */
function chromeWindow(
  windowType: 'float' | 'sidebar-left' | 'sidebar-right',
  name: string,
  run: string | null,
  splitFrom: PaneId | null,
  index: number | null,
): string {
  const at = index === null ? `:${name}` : `:${index}`;
  // A placeholder is no target: tmux has never heard of it.
  const from = splitFrom && !isPlaceholderId(splitFrom) ? ` -t ${splitFrom}` : '';
  return list([
    run === null ? `split-window${from}` : `split-window${from} ${quote(run)}`,
    index === null ? `break-pane -d -n ${name}` : `break-pane -d -n ${name} -t ${at}`,
    `set-option -w -t ${at} @tmuxy-window-type ${windowType}`,
  ]);
}

const NAV_WORD = { L: 'left', R: 'right', U: 'up', D: 'down' } as const;

/**
 * The pin a binding is prefixed with so it runs where the user is looking:
 * the window (which is what steers tmux's current target), then the pane.
 */
export function pinPrefix(windowId: WindowId | null, paneId: PaneId | null): string {
  const window = windowId ? `select-window -t ${windowId} \\; ` : '';
  const pane = paneId ? `select-pane -t ${paneId} \\; ` : '';
  return window + pane;
}

/** The one place an op becomes tmux syntax. */
export function toTmuxCommand(op: TmuxOp): string {
  switch (op._tag) {
    case 'Split':
      return op.direction === 'vertical' ? 'split-window -h' : 'split-window -v';
    case 'Navigate':
      return op.script
        ? `run-shell "bash ${SCRIPTS_DIR}/nav ${NAV_WORD[op.direction]} #{pane_id}"`
        : `select-pane -${op.direction}`;
    case 'SelectPane':
      return `select-pane -t ${op.paneId}`;
    case 'CyclePane':
      return `select-pane -t ${op.windowId ?? ':'}.+`;
    case 'LastPane':
      return 'last-pane';
    case 'Swap':
      return `swap-pane${op.keepFocus ? ' -d' : ''} -s ${op.sourcePaneId} -t ${op.targetPaneId}`;
    case 'SwapAdjacent':
      return `swap-pane -${op.direction}`;
    case 'SwapMarked':
      return 'swap-pane';
    case 'JoinMarked':
      return 'join-pane';
    case 'MarkPane':
      return op.marked ? 'select-pane -m' : 'select-pane -M';
    case 'BreakPane':
      return op.paneId ? `break-pane -s ${op.paneId}` : 'break-pane';
    case 'JoinPane':
      return `join-pane -s ${op.paneId} -t ${op.windowId}`;
    case 'KillPane':
      return op.paneId ? `kill-pane -t ${op.paneId}` : 'kill-pane';
    case 'ZoomToggle':
      return op.paneId ? `resize-pane -t ${op.paneId} -Z` : 'resize-pane -Z';
    case 'ResizePanes':
      return list(op.steps.map((s) => `resize-pane -t ${s.paneId} -${s.direction} ${s.cells}`));
    case 'SetPaneTitle':
      return `select-pane -t ${op.paneId} -T ${quote(op.title)}`;
    case 'ClearPane':
      return list(['send-keys -R', 'clear-history']);
    case 'PasteBuffer':
      return 'paste-buffer';
    case 'SendKeys':
      return `send-keys -t ${op.target} ${op.keys}`;
    case 'SendText':
      return literalText(op.target, op.text);
    case 'SendMouse':
      return mouseReport(op);
    case 'EnterCopyMode':
      return op.paneId ? `copy-mode -t ${op.paneId}` : 'copy-mode';
    case 'CancelCopyMode':
      return `send-keys -t ${op.paneId} -X cancel`;
    case 'AnswerAsk':
      return list([
        `set-option -pu -t ${op.paneId} @tmuxy-ask`,
        `set-option -p -t ${op.paneId} @tmuxy-ask-answer ${quote(`${op.token}:${op.answer}`)}`,
      ]);
    case 'NewWindow':
      return 'new-window';
    case 'SelectWindow':
      if (op.target === 'next') return 'next-window';
      if (op.target === 'previous') return 'previous-window';
      return `select-window -t ${op.target}`;
    case 'LastWindow':
      return 'last-window';
    case 'KillWindow':
      return op.windowId ? `kill-window -t ${op.windowId}` : 'kill-window';
    case 'RenameWindow':
      return op.target
        ? `rename-window -t ${op.target} -- ${quote(op.name)}`
        : `rename-window -- ${quote(op.name)}`;
    case 'MoveWindow':
      return `move-window -${op.placement === 'before' ? 'b' : 'a'} -s ${op.windowId} -t ${op.anchorId}`;
    case 'SelectLayout':
      if (op.layout === 'next') return 'next-layout';
      if (op.layout === 'previous') return 'previous-layout';
      return `select-layout ${op.layout}`;
    case 'SetWindowTag':
      return op.value === null
        ? `set-option -u -w -t ${op.windowId} @tmuxy-${op.tag}`
        : `set-option -w -t ${op.windowId} @tmuxy-${op.tag} ${op.value}`;
    case 'GroupAdd':
      return op.pane
        ? script('pane-group-add', op.pane.paneId, op.pane.width, op.pane.height)
        : script('pane-group-add', '#{pane_id}', '#{pane_width}', '#{pane_height}');
    case 'GroupClose':
      return script('pane-group-close', op.paneId);
    case 'GroupSwitch':
      return script('pane-group-switch', op.clickedPaneId);
    case 'GroupStep':
      return script(`pane-group-${op.direction}`, op.paneId ?? '#{pane_id}');
    case 'GroupMove':
      return script('pane-group-move', op.paneId, op.index);
    case 'GroupJoin':
      return script('pane-group-join', op.paneId, op.anchorPaneId, op.index);
    case 'GroupLeave':
      return op.to.kind === 'tab'
        ? script('pane-group-leave', op.paneId, '--tab')
        : script('pane-group-leave', op.paneId, '--beside', op.to.target, op.to.side);
    case 'OpenFloat':
      return chromeWindow('float', op.name, op.run, op.splitFrom, op.index);
    case 'OpenSidebar':
      return chromeWindow(
        `sidebar-${op.side}`,
        SIDEBAR_WINDOW_NAME[op.side],
        SIDEBAR_RUN[op.side],
        op.splitFrom,
        null,
      );
    case 'NewSession':
      return `new-session -d -s ${target(op.name)}`;
    case 'KillSession':
      return op.name === null ? 'kill-session' : `kill-session -t ${target(op.name)}`;
    case 'SwitchClient':
      return `switch-client -t ${target(op.session)}`;
    case 'RenameSession':
      return op.session === null
        ? `rename-session -- ${quote(op.name)}`
        : `rename-session -t ${target(op.session)} -- ${quote(op.name)}`;
    case 'SourceConfig':
      return `source-file ${CONFIG_FILE}`;
    case 'ClearFocusRequest':
      return `set-option -u -t ${target(op.session)} @tmuxy-focus-request`;
    case 'ClearSwitchRequest':
      return 'set-environment -g -u TMUXY_SWITCH_TO';
    case 'CommandPrompt':
      return [
        'command-prompt',
        ...(op.prompt === null ? [] : [`-p "${op.prompt}"`]),
        ...(op.initial ? [`-I "${op.initial}"`] : []),
        ...(op.template === null ? [] : [`"${op.template}"`]),
      ].join(' ');
    case 'DisplayMessage':
      return `display-message ${quote(op.message)}`;
    case 'RawCommand':
      return op.command;
  }
}

/** The prompt that renames the current tab, seeded with its name. */
export const renameWindowPrompt = (): TmuxOp =>
  TmuxOp.CommandPrompt({
    prompt: null,
    initial: '#W',
    template: toTmuxCommand(TmuxOp.RenameWindow({ target: null, name: '%%' })),
  });

/** The prompt that renames the session, seeded with its name. */
export const renameSessionPrompt = (): TmuxOp =>
  TmuxOp.CommandPrompt({
    prompt: null,
    initial: '#S',
    template: toTmuxCommand(TmuxOp.RenameSession({ session: null, name: '%%' })),
  });

/**
 * Ops that run a multi-step server script or create a window, whose
 * intermediate geometry must not animate. A raw string is classified by the
 * scripts it names.
 */
export function isMultiStep(op: TmuxOp): boolean {
  switch (op._tag) {
    case 'NewWindow':
    case 'GroupAdd':
    case 'GroupClose':
    case 'GroupSwitch':
    case 'GroupStep':
      return true;
    case 'RawCommand':
      return (
        /^run-shell\b/.test(op.command) &&
        /pane-group-(add|close|switch|next|prev)|float-create/.test(op.command)
      );
    default:
      return false;
  }
}

/** Ops that re-tile the window (a preset layout), for transient-focus suppression. */
export function isLayoutChange(op: TmuxOp): boolean {
  if (op._tag === 'SelectLayout') return true;
  return (
    op._tag === 'RawCommand' &&
    /^(next-layout|previous-layout|select-layout|selectl)\b/.test(op.command)
  );
}
