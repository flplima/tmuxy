/**
 * String → TmuxOp recogniser, for the commands that arrive as strings: the
 * bindings tmux reports (`list-keys`), what the user types at the command
 * prompt, tmuxy.conf aliases. Everything the client originates is built as a
 * `TmuxOp` in the first place and never passes through here.
 *
 * It recognises the shapes the client predicts or handles itself; anything
 * else is a `RawCommand`, forwarded to tmux verbatim with no prediction. The
 * caller keeps sending the original string (pin and flags included) — the op
 * only says what it means.
 */

import { TmuxOp, type PaneDirection } from '../../domain/commands';
import { isPaneId, isWindowId } from '../../domain/ids';

/**
 * Strip the pin keyboardActor prepends to every prefix/root binding —
 * `select-window -t @N \;` and/or `select-pane -t %N \;` (see `pinPrefix`) —
 * leaving the binding itself. Without this every binding would read as a
 * `SelectWindow`/`SelectPane` (the pin matches first) and the real operation
 * would be lost. The original command is still what goes to tmux.
 */
export function stripPin(command: string): string {
  const m = command.match(
    /^(?:select-window\s+-t\s+\S+\s+\\;\s*)?(?:select-pane\s+-t\s+\S+\s+\\;\s*)?/,
  );
  return m && m[0] ? command.slice(m[0].length) : command;
}

/** Shell-ish words: `'…'` and `"…"` are one word each, quotes removed. */
function words(command: string): string[] {
  const tokens: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/** `command-prompt [-p prompt] [-I initial] [flags] [template]`. */
function parseCommandPrompt(command: string): TmuxOp {
  const tokens = words(command);
  let prompt: string | null = null;
  let initial = '';
  let template: string | null = null;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i++];
    if (token === '-I' && i < tokens.length) initial = tokens[i++];
    else if (token === '-p' && i < tokens.length) prompt = tokens[i++];
    else if (token.startsWith('-')) {
      if (/^-[tTFN]$/.test(token) && i < tokens.length) i++;
    } else template = token;
  }
  return TmuxOp.CommandPrompt({ prompt, initial, template });
}

/** `display-message [flags] message`; with `-p` (print) it is tmux's, not the status line's. */
function parseDisplayMessage(command: string): TmuxOp {
  const tokens = words(command);
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i++];
    if (token === '-p') break;
    if (token.startsWith('-')) {
      if (/^-[tFc]$/.test(token) && i < tokens.length) i++;
    } else {
      return TmuxOp.DisplayMessage({ message: token });
    }
  }
  return TmuxOp.RawCommand({ command });
}

/** Commands that are exactly one bare verb (or its alias). */
const BARE: ReadonlyArray<[RegExp, () => TmuxOp]> = [
  [/^(new-window|neww)(\s|$)/, () => TmuxOp.NewWindow()],
  [/^(last-pane|lastp)$/, () => TmuxOp.LastPane()],
  [/^(last-window|last)$/, () => TmuxOp.LastWindow()],
  [/^(swap-pane|swapp)$/, () => TmuxOp.SwapMarked()],
  [/^(join-pane|joinp)$/, () => TmuxOp.JoinMarked()],
  [/^(break-pane|breakp)$/, () => TmuxOp.BreakPane({ paneId: null })],
  [/^(paste-buffer|pasteb)$/, () => TmuxOp.PasteBuffer()],
  [/^kill-session$/, () => TmuxOp.KillSession({ name: null })],
  [/^(next-window|nextw|next)(\s|$)/, () => TmuxOp.SelectWindow({ target: 'next' })],
  [/^(previous-window|prevw|prev)(\s|$)/, () => TmuxOp.SelectWindow({ target: 'previous' })],
  [/^(next-layout|nextl)$/, () => TmuxOp.SelectLayout({ layout: 'next' })],
  [/^(previous-layout|prevl)$/, () => TmuxOp.SelectLayout({ layout: 'previous' })],
];

const NAV = { left: 'L', right: 'R', up: 'U', down: 'D' } as const;

/**
 * Parse a tmux command string to a TmuxOp. Returns a `RawCommand` for
 * anything it can't or doesn't need to name.
 */
export function parseCommandToOp(command: string): TmuxOp {
  const trimmed = stripPin(command.trim());

  // split-window / splitw  (-h = side-by-side / new pane right; -v = stacked / new pane below)
  const splitMatch = trimmed.match(/^(split-window|splitw)\s+(-[hvV])/);
  if (splitMatch) {
    const flag = splitMatch[2].toLowerCase();
    return TmuxOp.Split({ direction: flag === '-h' ? 'vertical' : 'horizontal' });
  }

  // select-pane -L/-R/-U/-D — directional navigation
  const navMatch = trimmed.match(/^(select-pane|selectp)\s+-([LRUD])/i);
  if (navMatch) {
    const direction = navMatch[2].toUpperCase() as PaneDirection;
    return TmuxOp.Navigate({ direction, script: false });
  }

  // Unified navigation — the default Ctrl+hjkl / Ctrl+arrow root bindings.
  //
  // Two spellings reach us. The config writes `tmuxy-nav-left`, a
  // `command-alias`; but bindings arrive at the client through `list-keys`,
  // and tmux reports aliases ALREADY EXPANDED — so what a keypress actually
  // carries is the `run-shell "bash …/bin/tmuxy/nav <dir> …"` form. Matching
  // only the alias means every arrow key falls through to `RawCommand` and
  // loses its prediction, which is the difference between the highlight moving
  // on the next frame and waiting out a shell script plus a full round trip.
  //
  // Only the prediction is affected: the caller sends the original command
  // string, so tmux still runs the script and keeps its group/sidebar
  // semantics. Where the script would do something the geometric prediction
  // cannot know about — cycling within a pane group — `findAdjacentPane`
  // predicts the neighbour and the server's answer rolls it back, the same
  // reconcile path every other focus op uses. At the grid edge there is no
  // neighbour, so nothing is predicted at all.
  const navWord =
    trimmed.match(/^tmuxy-nav-(left|right|up|down)\b/)?.[1] ??
    trimmed.match(/^run-shell\s+.*\bbin\/tmuxy\/nav\s+(left|right|up|down)\b/)?.[1];
  if (navWord) {
    return TmuxOp.Navigate({ direction: NAV[navWord as keyof typeof NAV], script: true });
  }

  // Pane-group next/prev: the alias, or its expanded `run-shell` form.
  const groupStep =
    trimmed.match(/^tmuxy-pane-group-(next|prev)\b/) ??
    trimmed.match(/^run-shell\s+.*\/pane-group-(next|prev)\b(?:\s+(%\d+))?/);
  if (groupStep) {
    const paneId = groupStep[2];
    return TmuxOp.GroupStep({
      direction: groupStep[1] as 'next' | 'prev',
      paneId: isPaneId(paneId) ? paneId : null,
    });
  }

  // swap-pane -s %X -t %Y (and the reversed -t/-s form)
  const keepFocus = /\s-d\b/.test(trimmed);
  const swapForward = trimmed.match(/^(swap-pane|swapp)\s+.*-s\s+(%\d+)\s+.*-t\s+(%\d+)/);
  if (swapForward && isPaneId(swapForward[2]) && isPaneId(swapForward[3])) {
    return TmuxOp.Swap({
      sourcePaneId: swapForward[2],
      targetPaneId: swapForward[3],
      keepFocus,
    });
  }
  const swapReverse = trimmed.match(/^(swap-pane|swapp)\s+.*-t\s+(%\d+)\s+.*-s\s+(%\d+)/);
  if (swapReverse && isPaneId(swapReverse[2]) && isPaneId(swapReverse[3])) {
    return TmuxOp.Swap({
      sourcePaneId: swapReverse[3],
      targetPaneId: swapReverse[2],
      keepFocus,
    });
  }
  const swapAdjacent = trimmed.match(/^(swap-pane|swapp)\s+-([UD])$/);
  if (swapAdjacent) {
    return TmuxOp.SwapAdjacent({ direction: swapAdjacent[2] as 'U' | 'D' });
  }

  // select-pane -t :.+ / @N.+ — the next pane of a window, never predicted
  // (client/server drift compounds with each step).
  const cycle = trimmed.match(/^(select-pane|selectp)\s+-t\s+(?:(@\d+)|:)\.\+$/);
  if (cycle) {
    const windowId = cycle[2];
    return TmuxOp.CyclePane({ windowId: isWindowId(windowId) ? windowId : null });
  }
  // Other relative forms are recognised only so they are not misread below.
  if (/^(select-pane|selectp)\s+-t\s+(?:(?:\S*:)?\.|@\d+\.)\s*[+-]\s*$/.test(trimmed)) {
    return TmuxOp.RawCommand({ command });
  }

  const mark = trimmed.match(/^(select-pane|selectp)\s+-([mM])$/);
  if (mark) return TmuxOp.MarkPane({ marked: mark[2] === 'm' });

  // select-pane -t %X -T title — only the title changes; the focus does not.
  const title = trimmed.match(/^(select-pane|selectp)\s+-t\s+(%\d+)\s+-T\s+(.+)$/s);
  if (title && isPaneId(title[2])) {
    return TmuxOp.SetPaneTitle({ paneId: title[2], title: words(title[3])[0] ?? '' });
  }

  // select-pane -t %X — direct focus
  const selectPaneMatch = trimmed.match(/^(select-pane|selectp)\s+-t\s+(%\d+)/);
  if (selectPaneMatch && isPaneId(selectPaneMatch[2])) {
    return TmuxOp.SelectPane({ paneId: selectPaneMatch[2] });
  }

  for (const [pattern, make] of BARE) {
    if (pattern.test(trimmed)) return make();
  }

  // resize-pane -Z / resizep -Z — zoom toggle (must be checked before other
  // resize forms fall through to RawCommand)
  const zoomMatch = trimmed.match(/^(resize-pane|resizep)\s+(?:-t\s+(%\d+)\s+)?-Z\s*$/);
  if (zoomMatch) {
    return TmuxOp.ZoomToggle({ paneId: isPaneId(zoomMatch[2]) ? zoomMatch[2] : null });
  }

  // kill-pane / killp [-t %N]
  const killPaneMatch = trimmed.match(/^(kill-pane|killp)(?:\s+-t\s+(%\d+))?\s*$/);
  if (killPaneMatch) {
    return TmuxOp.KillPane({ paneId: isPaneId(killPaneMatch[2]) ? killPaneMatch[2] : null });
  }

  // kill-window / killw [-t @N] — index-form targets (`-t :2`) resolve
  // server-side and are deliberately not predicted.
  const killWindowMatch = trimmed.match(/^(kill-window|killw)(?:\s+-t\s+(@\d+))?\s*$/);
  if (killWindowMatch) {
    const windowId = killWindowMatch[2];
    return TmuxOp.KillWindow({ windowId: isWindowId(windowId) ? windowId : null });
  }

  // rename-window / renamew [-t target] [--] NAME
  const renameMatch = trimmed.match(
    /^(rename-window|renamew)(?:\s+-t\s+(\S+))?\s+(?:--\s+)?(.+?)\s*$/,
  );
  if (renameMatch) {
    let name = renameMatch[3];
    const quoted = name.match(/^'(.*)'$/s) ?? name.match(/^"(.*)"$/s);
    if (quoted) name = quoted[1];
    // Only @-form or absent targets are predictable client-side.
    const target = renameMatch[2];
    if (target === undefined) return TmuxOp.RenameWindow({ target: null, name });
    if (isWindowId(target)) return TmuxOp.RenameWindow({ target, name });
    return TmuxOp.RawCommand({ command });
  }

  // select-window -t @N (by id — what the client's own tab switch sends, so a
  // stale index can never land on the wrong window) or -t N (by index, with
  // optional `:` and `=` prefixes).
  const selectWinId = trimmed.match(/^(select-window|selectw)\s+-t\s+(@\d+)/);
  if (selectWinId && isWindowId(selectWinId[2])) {
    return TmuxOp.SelectWindow({ target: selectWinId[2] });
  }
  const selectWinIdx = trimmed.match(/^(select-window|selectw)\s+-t\s+:?=?(\d+)/);
  if (selectWinIdx) {
    return TmuxOp.SelectWindow({ target: parseInt(selectWinIdx[2], 10) });
  }

  const layout = trimmed.match(/^(select-layout|selectl)\s+([\w-]+)$/);
  if (layout) return TmuxOp.SelectLayout({ layout: layout[2] });

  const copyMode = trimmed.match(/^copy-mode\b(?:.*\s-t\s+(%\d+))?/);
  if (copyMode) return TmuxOp.EnterCopyMode({ paneId: isPaneId(copyMode[1]) ? copyMode[1] : null });

  if (/^command-prompt\b/.test(trimmed)) return parseCommandPrompt(trimmed);
  if (/^(display-message|display)(\s|$)/.test(trimmed)) {
    const op = parseDisplayMessage(trimmed);
    return op._tag === 'RawCommand' ? TmuxOp.RawCommand({ command }) : op;
  }

  return TmuxOp.RawCommand({ command });
}
