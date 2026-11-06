/**
 * The command vocabulary: every intent the client issues to tmux, as data.
 * This module is the only place in the UI that spells tmux syntax — verbs,
 * flags, quoting and the paths of the bundled scripts.
 *
 * Strings that arrive as strings — the bindings tmux reports (`list-keys`),
 * what the user types at the command prompt, tmuxy.conf aliases — are
 * recognised by `domain/store/parseCommand.ts`; whatever it cannot name stays a
 * `RawCommand`, sent verbatim.
 */

import { Data } from 'effect';
import { type PaneId, type WindowId } from './ids';
import {
  openFloat,
  sidebarWindowCommand,
  list,
  literalText,
  mouseReport,
  NAV_WORD,
  pastedText,
  pluginAction,
  script,
  scriptWith,
  target,
  tmuxDoubleQuoted,
} from './commandHelpers';
import { LEFT_SIDEBAR_WIDGET, SIDEBAR_WINDOW_PREFIX } from './tmuxyConstants.gen';

/** The bundled scripts, in the data dir the config chain publishes to tmux. */
export const SCRIPTS_DIR = '$TMUXY_DATA_DIR/bin/tmuxy';

/** tmuxy's config chain (the server sources its own); never `~/.tmux.conf`. */
export const CONFIG_FILE = '$TMUXY_ENTRY_CONF';

/** The fixed window name of a sidebar column: unique, so a create can target it by name. */
export const SIDEBAR_WINDOW_NAME = {
  left: `${SIDEBAR_WINDOW_PREFIX}left`,
  right: `${SIDEBAR_WINDOW_PREFIX}right`,
} as const;

/**
 * What a sidebar column runs: the tree widget, or (`null`) the default shell.
 * The tree runs by its installed path, never a bare `tmuxy`: PATH may hold a
 * stale launcher (one left pointing at an unmounted AppImage) that exits at
 * once and takes the column's window with it. A restore recognises a sidebar
 * by this command, so it is tmuxy-core's (`LEFT_SIDEBAR_WIDGET`).
 */
const SIDEBAR_RUN = {
  left: LEFT_SIDEBAR_WIDGET,
  right: null,
} as const;

export type PaneDirection = 'L' | 'R' | 'U' | 'D';

/** Which way a pane splits: `vertical` puts the new pane beside, `horizontal` below. */
export type SplitDirection = 'horizontal' | 'vertical';

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

type NoFields = Record<never, never>;

/**
 * Every intent the client issues, as a tagged union. A `null` target means
 * "tmux's current one" — the store and machine resolve it where the client's
 * own idea of "current" is the better one (see `routeOp`).
 */
export type TmuxOp = Data.TaggedEnum<{
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
  /** tmux's top paste buffer into the current pane, bracketed if the pane asked. */
  PasteBuffer: NoFields;
  /** Key names (`C-c`, `Up`) to a pane — or, as a last resort, a session's active pane. */
  SendKeys: { readonly target: PaneId | string; readonly keys: string };
  /** Text typed literally, line by line. */
  SendText: { readonly target: PaneId | string; readonly text: string };
  /** Text pasted as one paste: bracketed when the program in the pane asked for it. */
  PasteText: { readonly target: PaneId | string; readonly text: string };
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
   * Answer a send waiting on a pane: withdraw the question, then record the
   * answer pinned to its token, so an answer to a question the asker already
   * withdrew is not read as one to whatever replaced it. The clear goes first so
   * the overlay comes down the instant the user chooses.
   */
  AnswerAsk: { readonly paneId: PaneId; readonly token: string; readonly answer: string };
  /**
   * Answer a restore's offer: withdraw it, and on `run` type the command and
   * run it. No process waits on an offer, so the answer is the work itself.
   */
  AnswerOffer: { readonly paneId: PaneId; readonly command: string; readonly run: boolean };
  /** Take back what a pane declared about itself (`@tmuxy-pane-state`). */
  ClearPaneState: { readonly paneId: PaneId };

  NewWindow: NoFields;
  SelectWindow: {
    /** A window id (`@N`, what the client sends), a tmux index, or a neighbour. */
    readonly target: WindowId | number | 'next' | 'previous';
  };
  LastWindow: NoFields;
  /** Only `@N`-form targets are predicted. */
  KillWindow: { readonly windowId: WindowId | null };
  RenameWindow: { readonly target: WindowId | null; readonly name: string };
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
  GroupMove: { readonly paneId: PaneId; readonly index: number };
  /** An ungrouped pane joins `anchorPaneId`'s group, out of view, at `index`. */
  GroupJoin: { readonly paneId: PaneId; readonly anchorPaneId: PaneId; readonly index: number };
  GroupLeave: { readonly paneId: PaneId; readonly to: LeaveDestination };

  /** A float running `command` (its words), over the tab `splitFrom` is in. */
  OpenFloat: { readonly command: readonly string[]; readonly splitFrom: PaneId | null };
  OpenSidebar: { readonly side: 'left' | 'right'; readonly splitFrom: PaneId | null };

  NewSession: { readonly name: string };
  KillSession: { readonly name: string | null };
  /** Move this client to another session (the desktop app's one control client). */
  SwitchClient: { readonly session: string };
  RenameSession: { readonly session: string | null; readonly name: string };
  SourceConfig: NoFields;
  /** Clear the one-shot focus request a shell helper queued. */
  ClearFocusRequest: { readonly session: string };

  /** A plugin's action on a pane (`tmuxy plugin action`); `token` carries a selection. */
  PluginAction: {
    readonly plugin: string;
    readonly action: string;
    readonly paneId: PaneId;
    readonly token: string | null;
  };

  /** Open the client's command prompt; `%%` in `template` takes what was typed. */
  CommandPrompt: {
    readonly prompt: string | null;
    readonly initial: string;
    readonly template: string | null;
  };

  /** A string the client did not originate and cannot name; sent verbatim. */
  RawCommand: { readonly command: string };
}>;

export const TmuxOp = Data.taggedEnum<TmuxOp>();

export type TmuxOpOf<T extends TmuxOp['_tag']> = Extract<TmuxOp, { readonly _tag: T }>;

/**
 * Free text as one tmux argument, single-quoted (`it's` → `'it'\''s'`).
 *
 * Control mode reads one command per line, and nothing escapes inside single
 * quotes: a newline in a name or a title would end the command there and run
 * the rest as tmux commands of its own. Text holding any control character
 * goes double-quoted instead, every unsafe byte an octal escape.
 */
export function quote(text: string): string {
  if (hasControlCharacter(text)) return tmuxDoubleQuoted(text);
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * The pin a binding is prefixed with so it runs where the user is looking:
 * the window (which is what steers tmux's current target), then the pane.
 */
export function pinPrefix(windowId: WindowId | null, paneId: PaneId | null): string {
  const pins = [
    ...(windowId ? [`select-window -t ${windowId}`] : []),
    ...(paneId ? [`select-pane -t ${paneId}`] : []),
  ];
  return list([...pins, '']);
}

export function toTmuxCommand(op: TmuxOp): string {
  switch (op._tag) {
    case 'Split':
      return op.direction === 'vertical' ? 'split-window -h' : 'split-window -v';
    case 'Navigate':
      return op.script ? `tmuxy-nav-${NAV_WORD[op.direction]}` : `select-pane -${op.direction}`;
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
      // `send-keys -R` resets the pane inside tmux, which no client sees as
      // output; C-l has the shell clear the screen and redraw, which it does.
      return list(['send-keys -R', 'send-keys C-l', 'clear-history']);
    case 'PasteBuffer':
      return 'paste-buffer -p';
    case 'SendKeys':
      return `send-keys -t ${target(op.target)} ${op.keys}`;
    case 'SendText':
      return literalText(op.target, op.text);
    case 'PasteText':
      return pastedText(op.target, op.text);
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
    case 'AnswerOffer':
      return op.run
        ? [
            `set-option -pu -t ${op.paneId} @tmuxy-ask`,
            literalText(op.paneId, op.command),
            `send-keys -t ${op.paneId} Enter`,
          ].join('\n')
        : `set-option -pu -t ${op.paneId} @tmuxy-ask`;
    case 'ClearPaneState':
      return `set-option -pu -t ${op.paneId} @tmuxy-pane-state`;
    case 'NewWindow':
      return 'new-window';
    case 'SelectWindow':
      if (op.target === 'next') return 'next-window';
      if (op.target === 'previous') return 'previous-window';
      return `select-window -t ${op.target}`;
    case 'LastWindow':
      return 'last-window';
    case 'KillWindow':
      // A killed window takes its group members with it but not the parked
      // ones in the stash (`pane-died` does not fire for a kill), so the
      // sweep every group operation ends with runs here too.
      return list([
        op.windowId ? `kill-window -t ${op.windowId}` : 'kill-window',
        script('pane-group', 'gc'),
      ]);
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
        ? scriptWith('settle', 'pane-group', 'add', op.pane.paneId, op.pane.width, op.pane.height)
        : scriptWith(
            'settle',
            'pane-group',
            'add',
            '#{pane_id}',
            '#{pane_width}',
            '#{pane_height}',
          );
    case 'GroupClose':
      return scriptWith('settle', 'pane-group', 'close', op.paneId);
    case 'GroupSwitch':
      return scriptWith('settle', 'pane-group', 'switch', op.clickedPaneId);
    case 'GroupStep':
      return scriptWith('settle', 'pane-group', op.direction, op.paneId ?? '#{pane_id}');
    case 'GroupMove':
      return script('pane-group', 'move', op.paneId, op.index);
    case 'GroupJoin':
      return script('pane-group', 'join', op.paneId, op.anchorPaneId, op.index);
    case 'GroupLeave':
      return op.to.kind === 'tab'
        ? script('pane-group', 'leave', op.paneId, '--tab')
        : script('pane-group', 'leave', op.paneId, '--beside', op.to.target, op.to.side);
    case 'OpenFloat':
      return openFloat(op);
    case 'OpenSidebar':
      return sidebarWindowCommand(
        op.side,
        SIDEBAR_WINDOW_NAME[op.side],
        SIDEBAR_RUN[op.side],
        op.splitFrom,
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
    case 'PluginAction':
      return pluginAction(op);
    case 'CommandPrompt':
      return [
        'command-prompt',
        ...(op.prompt === null ? [] : [`-p "${op.prompt}"`]),
        ...(op.initial ? [`-I "${op.initial}"`] : []),
        ...(op.template === null ? [] : [`"${op.template.replace(/[\\"]/g, '\\$&')}"`]),
      ].join(' ');
    case 'RawCommand':
      return op.command;
  }
}

/**
 * What the user types into a prompt, as one double-quoted argument: tmux
 * puts it in place of `%%%` with its quotes, `\`, `$`, `;` and `~` escaped,
 * so a name with a quote in it stays a name. A single-quoted `'%%'` let a
 * typed `'` end the quote and run the rest as commands.
 */
const PROMPT_RESPONSE = '"%%%"';

export const renameWindowPrompt = (): TmuxOp =>
  TmuxOp.CommandPrompt({
    prompt: null,
    initial: '#W',
    template: `rename-window -- ${PROMPT_RESPONSE}`,
  });

export const renameSessionPrompt = (): TmuxOp =>
  TmuxOp.CommandPrompt({
    prompt: null,
    initial: '#S',
    template: `rename-session -- ${PROMPT_RESPONSE}`,
  });
