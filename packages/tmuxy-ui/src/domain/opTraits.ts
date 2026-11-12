import type { TmuxOp, TmuxOpOf } from './commands';
import { commandListParts, runShellScript } from './store/parseCommand';

type Tag = TmuxOp['_tag'];

interface OpTraits<O> {
  /**
   * What the store shows ahead of tmux: a `layout` (a rollback visibly
   * reverts the screen, so it is reported to the user), a `pin` on a focus
   * or a tag, or nothing. `domain/store/ops.ts` has a predictor for exactly
   * the ops that predict something.
   */
  readonly predicts: 'layout' | 'pin' | null;
  /**
   * Runs a multi-step server script or creates a window: its intermediate
   * geometry must not animate.
   */
  readonly multiStep: boolean | ((op: O) => boolean);
  /**
   * Which focus tmux moves when it runs the op: the active `pane`, or the
   * active `window` (and with it the pane). Pending focus pins it moves away
   * from are dropped (`dropSupersededFocusOps`).
   */
  readonly focus: 'pane' | 'window' | null;
}

const NONE = { predicts: null, multiStep: false, focus: null } as const;

/**
 * Every op's traits. The type wants a row per `TmuxOp` tag, so a new op does
 * not compile until it says what it predicts, whether it animates and which
 * focus it moves.
 */
export const OP_TRAITS = {
  Split: { predicts: 'layout', multiStep: false, focus: 'pane' },
  Navigate: { predicts: 'pin', multiStep: false, focus: 'pane' },
  SelectPane: { predicts: 'pin', multiStep: false, focus: 'pane' },
  CyclePane: { ...NONE, focus: 'pane' },
  LastPane: { ...NONE, focus: 'pane' },
  Swap: { predicts: 'layout', multiStep: false, focus: null },
  SwapAdjacent: NONE,
  SwapMarked: NONE,
  JoinMarked: { ...NONE, focus: 'pane' },
  MarkPane: NONE,
  // Without -d, break-pane and join-pane select the window the pane lands in.
  BreakPane: { ...NONE, focus: 'window' },
  JoinPane: { predicts: 'layout', multiStep: false, focus: 'window' },
  KillPane: { predicts: 'layout', multiStep: false, focus: 'pane' },
  ZoomToggle: { predicts: 'layout', multiStep: false, focus: null },
  ResizePanes: NONE,
  SetPaneTitle: NONE,
  ClearPane: NONE,
  PasteBuffer: NONE,
  SendKeys: NONE,
  SendText: NONE,
  PasteText: NONE,
  SendReview: NONE,
  SendMouse: NONE,
  EnterCopyMode: NONE,
  CancelCopyMode: NONE,
  AnswerAsk: NONE,
  AnswerOffer: NONE,
  ClearPaneState: NONE,
  NewWindow: { predicts: 'layout', multiStep: true, focus: 'window' },
  SelectWindow: { predicts: 'pin', multiStep: false, focus: 'window' },
  LastWindow: { ...NONE, focus: 'window' },
  KillWindow: { predicts: 'layout', multiStep: false, focus: 'window' },
  RenameWindow: { predicts: 'layout', multiStep: false, focus: null },
  MoveWindow: { predicts: 'layout', multiStep: false, focus: null },
  SelectLayout: NONE,
  SetWindowTag: { predicts: 'pin', multiStep: false, focus: null },
  // The group verbs bring a member into view with swap-pane, which moves the
  // active pane with it.
  GroupAdd: { predicts: null, multiStep: true, focus: 'pane' },
  GroupClose: { predicts: null, multiStep: true, focus: 'pane' },
  GroupSwitch: { predicts: 'layout', multiStep: false, focus: 'pane' },
  GroupStep: { predicts: null, multiStep: true, focus: 'pane' },
  GroupMove: { predicts: 'layout', multiStep: false, focus: null },
  GroupJoin: NONE,
  GroupLeave: NONE,
  OpenFloat: NONE,
  OpenSidebar: NONE,
  NewSession: NONE,
  KillSession: NONE,
  SwitchClient: NONE,
  RenameSession: NONE,
  SourceConfig: NONE,
  ClearFocusRequest: NONE,
  PluginAction: NONE,
  CommandPrompt: NONE,
  // A raw string (a key binding's, an essentials alias expanded), by the
  // effect its script run is marked with.
  RawCommand: {
    ...NONE,
    multiStep: (op) =>
      commandListParts(op.command).some((part) => runShellScript(part)?.effect === 'settle'),
  },
} as const satisfies { readonly [T in Tag]: OpTraits<TmuxOpOf<T>> };

/** The tags `domain/store/ops.ts` must have a predictor for, and only those. */
export type PredictedTag = {
  [T in Tag]: (typeof OP_TRAITS)[T]['predicts'] extends null ? never : T;
}[Tag];

export function isMultiStep(op: TmuxOp): boolean {
  const { multiStep } = OP_TRAITS[op._tag] as OpTraits<TmuxOp>;
  return typeof multiStep === 'function' ? multiStep(op) : multiStep;
}

export function isStructural(op: TmuxOp): boolean {
  return OP_TRAITS[op._tag].predicts === 'layout';
}

/**
 * Whether `later` moves the focus the pending op `pinned` pins (a window move
 * takes the pane with it), so that pin must stop holding it.
 */
export function supersedesPin(later: TmuxOp, pinned: TmuxOp): boolean {
  const moved = OP_TRAITS[later._tag].focus;
  const pin = OP_TRAITS[pinned._tag];
  if (moved === null || pin.predicts !== 'pin' || pin.focus === null) return false;
  return pin.focus === 'pane' || moved === 'window';
}
