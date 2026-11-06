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

import { TmuxOp, type PaneDirection } from '../commands';
import { isPaneId, isWindowId } from '../ids';
import type { ScriptEffect } from '../commandHelpers';

/**
 * One word of a command as tmux's parser reads it, with where it sits in the
 * string: `'…'` and `"…"` are one word each, quotes removed, with `\"` and
 * `\\` inside double quotes standing for themselves (how `list-keys` prints a
 * template holding quotes); a `{ … }` block is one word, its contents (how it
 * prints a template given as a block).
 */
interface Token {
  word: string;
  start: number;
  end: number;
  /** Written bare, so a `;` or `\;` here separates commands. */
  bare: boolean;
}

function tokens(command: string): Token[] {
  const found: Token[] = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|\{\s*([^}]*?)\s*\}|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const word = m[2] !== undefined ? m[2].replace(/\\(["\\])/g, '$1') : (m[1] ?? m[3] ?? m[4]);
    found.push({ word, start: m.index, end: re.lastIndex, bare: m[4] !== undefined });
  }
  return found;
}

export function commandWords(command: string): string[] {
  return tokens(command).map((t) => t.word);
}

const isSeparator = (t: Token) => t.bare && (t.word === ';' || t.word === '\\;');

function listParts(command: string): Array<{ text: string; start: number }> {
  const parts: Array<{ text: string; start: number }> = [];
  let first: Token | null = null;
  let last: Token | null = null;
  const close = () => {
    if (first && last)
      parts.push({ text: command.slice(first.start, last.end), start: first.start });
    first = last = null;
  };
  for (const token of tokens(command)) {
    if (isSeparator(token)) close();
    else {
      first ??= token;
      last = token;
    }
  }
  close();
  return parts;
}

/** The commands of a tmux command list (`a \; b`), each verbatim. */
export function commandListParts(command: string): string[] {
  return listParts(command).map((p) => p.text);
}

/**
 * Strip the pin keyboardActor prepends to every prefix/root binding —
 * `select-window -t @N \;` and/or `select-pane -t %N \;` (`pinPrefix`) —
 * leaving the binding itself. Without this every binding would read as a
 * `SelectWindow`/`SelectPane` (the pin matches first) and the real operation
 * would be lost. The original command is still what goes to tmux.
 */
export function stripPin(command: string): string {
  const parts = listParts(command);
  let i = 0;
  if (i < parts.length - 1 && /^select-window\s+-t\s+\S+$/.test(parts[i].text)) i++;
  if (i < parts.length - 1 && /^select-pane\s+-t\s+\S+$/.test(parts[i].text)) i++;
  return i === 0 ? command : command.slice(parts[i].start);
}

/**
 * The script a `run-shell` command runs — `name` is its file name, `bundled`
 * whether it is one of tmuxy's own (`bin/tmuxy/`) — with its arguments and
 * the effect its line is marked with (`TMUXY_EFFECT=…`, see `scriptWith`);
 * null for any other command. Variable assignments and `bash`/`sh` in front
 * of the path are skipped, as the config's aliases put them there.
 */
export function runShellScript(
  command: string,
): { name: string; bundled: boolean; args: string[]; effect: ScriptEffect | null } | null {
  const words = commandWords(command);
  if (words[0] !== 'run-shell') return null;
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += /^-[dt]$/.test(words[i]) ? 2 : 1;
  if (i >= words.length) return null;
  const shell = commandWords(words[i]);
  let at = 0;
  let effect: ScriptEffect | null = null;
  for (let m; at < shell.length && (m = shell[at].match(/^(\w+)=(.*)$/)); at++) {
    if (m[1] === 'TMUXY_EFFECT' && (m[2] === 'settle' || m[2] === 'relist-windows')) effect = m[2];
  }
  if (shell[at] === 'bash' || shell[at] === 'sh') at++;
  const path = shell[at];
  if (path === undefined) return null;
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    bundled: path.includes('bin/tmuxy/'),
    args: shell.slice(at + 1),
    effect,
  };
}

/**
 * `select-window -t N` exactly, the binding of a tab's visual position (the
 * `tab` table's digits): N, or null for any other command.
 */
export function tabPosition(command: string): number | null {
  const m = stripPin(command).match(/^select-window\s+-t\s+(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** `-c "#{pane_current_path}"`, in any quoting: a start directory, not a different command. */
const isCurrentPathFlag = (flag: Token, value: Token | undefined) =>
  flag.bare && flag.word === '-c' && value?.word === '#{pane_current_path}';

/**
 * What a bound command does, for matching it to a menu item's: a split or a
 * new window that starts in the pane's directory is still that split or
 * window, and a kill that asks first (tmux's own `x`) is still that kill.
 */
export function boundAction(command: string): string {
  let action = command.trim();
  const words = tokens(action);
  if (words[0]?.word === 'confirm-before') {
    let i = 1;
    while (i < words.length && /^-[by]+$/.test(words[i].word)) i++;
    while (i < words.length && /^-[pct]$/.test(words[i].word)) i += 2;
    const rest = words.slice(i);
    if (rest.length === 0) return '';
    action = rest.length === 1 ? rest[0].word : action.slice(rest[0].start);
  }
  const all = tokens(action);
  let out = '';
  let from = 0;
  for (let i = 0; i < all.length; i++) {
    if (!isCurrentPathFlag(all[i], all[i + 1])) continue;
    out += action.slice(from, all[i].start).trimEnd();
    from = all[i + 1].end;
    i++;
  }
  return (out + action.slice(from)).trim();
}

/** `command-prompt [-p prompt] [-I initial] [flags] [template]`. */
function parseCommandPrompt(command: string): TmuxOp {
  const tokens = commandWords(command);
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

const BARE: ReadonlyArray<[RegExp, () => TmuxOp]> = [
  [/^(new-window|neww)(\s|$)/, () => TmuxOp.NewWindow()],
  [/^(last-pane|lastp)$/, () => TmuxOp.LastPane()],
  [/^(last-window|last)$/, () => TmuxOp.LastWindow()],
  [/^(swap-pane|swapp)$/, () => TmuxOp.SwapMarked()],
  [/^(join-pane|joinp)$/, () => TmuxOp.JoinMarked()],
  [/^(break-pane|breakp)$/, () => TmuxOp.BreakPane({ paneId: null })],
  [/^(paste-buffer|pasteb)( -p)?$/, () => TmuxOp.PasteBuffer()],
  [/^kill-session$/, () => TmuxOp.KillSession({ name: null })],
  [/^(next-window|nextw|next)(\s|$)/, () => TmuxOp.SelectWindow({ target: 'next' })],
  [/^(previous-window|prevw|prev)(\s|$)/, () => TmuxOp.SelectWindow({ target: 'previous' })],
  [/^(next-layout|nextl)$/, () => TmuxOp.SelectLayout({ layout: 'next' })],
  [/^(previous-layout|prevl)$/, () => TmuxOp.SelectLayout({ layout: 'previous' })],
];

const NAV = { left: 'L', right: 'R', up: 'U', down: 'D' } as const;

export function parseCommandToOp(command: string): TmuxOp {
  const trimmed = stripPin(command.trim());

  // tmux's -h is side by side (new pane right), -v stacked (new pane below).
  const splitMatch = trimmed.match(/^(split-window|splitw)\s+(-[hvV])/);
  if (splitMatch) {
    const flag = splitMatch[2].toLowerCase();
    return TmuxOp.Split({ direction: flag === '-h' ? 'vertical' : 'horizontal' });
  }

  const navMatch = trimmed.match(/^(select-pane|selectp)\s+-([LRUD])/i);
  if (navMatch) {
    const direction = navMatch[2].toUpperCase() as PaneDirection;
    return TmuxOp.Navigate({ direction, script: false });
  }

  // The default Ctrl+hjkl / Ctrl+arrow bindings. The config writes the
  // `tmuxy-nav-left` command-alias, but `list-keys` reports aliases ALREADY
  // EXPANDED, so a keypress carries the `run-shell "bash …/bin/tmuxy/nav <dir>"`
  // form; both must match or every arrow key loses its prediction. Where the
  // script does what geometry cannot know (cycling within a pane group), the
  // server's answer rolls the prediction back.
  const script = runShellScript(trimmed);
  const navWord =
    trimmed.match(/^tmuxy-nav-(left|right|up|down)\b/)?.[1] ??
    (script?.bundled && script.name === 'nav' ? script.args[0] : undefined);
  if (navWord !== undefined && Object.prototype.hasOwnProperty.call(NAV, navWord)) {
    return TmuxOp.Navigate({ direction: NAV[navWord as keyof typeof NAV], script: true });
  }

  // Pane-group next/prev: the alias, or its expanded `run-shell` form.
  const alias = trimmed.match(/^tmuxy-pane-group-(next|prev)\b/);
  const [step, paneArg]: Array<string | undefined> = alias
    ? [alias[1]]
    : script?.name === 'pane-group'
      ? script.args
      : [];
  if (step === 'next' || step === 'prev') {
    return TmuxOp.GroupStep({ direction: step, paneId: isPaneId(paneArg) ? paneArg : null });
  }

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
    return TmuxOp.SetPaneTitle({ paneId: title[2], title: commandWords(title[3])[0] ?? '' });
  }

  const selectPaneMatch = trimmed.match(/^(select-pane|selectp)\s+-t\s+(%\d+)/);
  if (selectPaneMatch && isPaneId(selectPaneMatch[2])) {
    return TmuxOp.SelectPane({ paneId: selectPaneMatch[2] });
  }

  for (const [pattern, make] of BARE) {
    if (pattern.test(trimmed)) return make();
  }

  const zoomMatch = trimmed.match(/^(resize-pane|resizep)\s+(?:-t\s+(%\d+)\s+)?-Z\s*$/);
  if (zoomMatch) {
    return TmuxOp.ZoomToggle({ paneId: isPaneId(zoomMatch[2]) ? zoomMatch[2] : null });
  }

  const killPaneMatch = trimmed.match(/^(kill-pane|killp)(?:\s+-t\s+(%\d+))?\s*$/);
  if (killPaneMatch) {
    return TmuxOp.KillPane({ paneId: isPaneId(killPaneMatch[2]) ? killPaneMatch[2] : null });
  }

  // Index-form targets (`-t :2`) resolve server-side and are not predicted.
  const killWindowMatch = trimmed.match(/^(kill-window|killw)(?:\s+-t\s+(@\d+))?\s*$/);
  if (killWindowMatch) {
    const windowId = killWindowMatch[2];
    return TmuxOp.KillWindow({ windowId: isWindowId(windowId) ? windowId : null });
  }

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

  // By id (what the client's own tab switch sends, so a stale index never
  // lands on the wrong window) or by index (`:` and `=` prefixes optional).
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

  return TmuxOp.RawCommand({ command });
}
