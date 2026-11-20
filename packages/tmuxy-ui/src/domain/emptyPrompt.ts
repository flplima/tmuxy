/**
 * Whether a pane looks like it sits at an empty shell prompt, where Ctrl+C
 * closes it (`TmuxOp.InterruptOrEof`: tmux sends EOF only while a shell is in
 * front, and the shell exits on it only when its line is empty, so the shell
 * makes the final call).
 *
 * The client cannot read a shell's line, so it reads the screen. A pane's
 * prompt is marked (where the cursor is, and the text before it) as the
 * frames draw it, until something is typed into the pane; from then on the
 * line is empty again only when the cursor is back at the mark with the same
 * text before it, so a line typed and deleted again counts, a recalled one
 * does not. An Enter or a Ctrl+C gives the line up: the mark goes, and the
 * next prompt drawn is the new one.
 *
 * Pure: the keyboard slice keeps a `PaneLine` per pane (`paneLines`) and runs
 * these as input goes out and frames come in.
 */

import type { TmuxPane } from './client';
import type { TmuxOp } from './commands';
import { isPaneId, type PaneId } from './ids';
import { SHELLS } from './tmuxyConstants.gen';

/** A prompt's cursor, and the text of its row before it. */
export interface PromptMark {
  readonly row: number;
  readonly col: number;
  readonly before: string;
}

/** What this client knows of a pane's shell line. */
export interface PaneLine {
  /** Something was typed into it from here since its last Enter or Ctrl+C. */
  readonly typed: boolean;
  /** The prompt, as the frames drew it before anything was typed. */
  readonly mark: PromptMark | null;
  /**
   * After an Enter or a Ctrl+C that gave up a typed line: the prompt it was
   * typed at. A frame that still shows that line (drawn before the key
   * reached the shell) is not the next prompt.
   */
  readonly givenUp: PromptMark | null;
}

export type PaneLines = Readonly<Record<PaneId, PaneLine>>;

/** A pane nothing was typed into and no prompt was seen in. */
const UNTOUCHED: PaneLine = { typed: false, mark: null, givenUp: null };

/** What an input does to the line: `ends` it (Enter, Ctrl+C) or `types` into it. */
export type LineInput = 'ends' | 'types';

const ENDS_LINE = new Set(['Enter', 'C-m', 'C-j', 'C-c']);

/** Whether `command` is a shell, as core's `is_shell_name` tells: a login shell's `-` and a path dropped. */
export function isShellCommand(command: string): boolean {
  const name = command.replace(/^-+/, '');
  return (SHELLS as readonly string[]).includes(name.slice(name.lastIndexOf('/') + 1));
}

type Screen = Pick<TmuxPane, 'command' | 'content' | 'cursorX' | 'cursorY' | 'alternateOn'>;

/**
 * The pane's cursor as a prompt's, or null: a program in front, or no text
 * before the cursor (a prompt always has some, an empty row is a program's).
 */
export function promptMarkOf(pane: Screen): PromptMark | null {
  if (pane.alternateOn || !isShellCommand(pane.command)) return null;
  const row = pane.content[pane.cursorY] ?? [];
  const before = row
    .slice(0, pane.cursorX)
    .map((cell) => cell.c)
    .join('')
    .trimEnd();
  return before === '' ? null : { row: pane.cursorY, col: pane.cursorX, before };
}

function sameMark(a: PromptMark, b: PromptMark): boolean {
  return a.row === b.row && a.col === b.col && a.before === b.before;
}

/** Whether `mark` is on the line typed at `prompt`: its row, past it, the prompt's text and more. */
function onLineOf(mark: PromptMark, prompt: PromptMark): boolean {
  return mark.row === prompt.row && mark.col > prompt.col && mark.before.startsWith(prompt.before);
}

/** The pane `op` types into and what it does to the line there, or null for an op that types nothing. */
export function inputOf(op: TmuxOp): { readonly paneId: PaneId; readonly input: LineInput } | null {
  switch (op._tag) {
    case 'SendKeys':
      // A flag is a command to the pane (`-X cancel`), not a key typed.
      if (op.keys.startsWith('-') || !isPaneId(op.target)) return null;
      return { paneId: op.target, input: ENDS_LINE.has(op.keys) ? 'ends' : 'types' };
    case 'SendText':
    case 'PasteText':
      return isPaneId(op.target) ? { paneId: op.target, input: 'types' } : null;
    case 'InterruptOrEof':
      return { paneId: op.paneId, input: 'ends' };
    default:
      return null;
  }
}

/** `lines` once `input` went into `paneId`. */
export function afterInput(lines: PaneLines, paneId: PaneId, input: LineInput): PaneLines {
  const line = lines[paneId] ?? UNTOUCHED;
  if (input === 'types' && line.typed) return lines;
  const next: PaneLine =
    input === 'ends'
      ? { typed: false, mark: null, givenUp: line.typed ? line.mark : line.givenUp }
      : { typed: true, mark: line.mark, givenUp: null };
  return { ...lines, [paneId]: next };
}

function withFrame(line: PaneLine, pane: TmuxPane): PaneLine {
  if (line.typed) return line;
  const mark = promptMarkOf(pane);
  if (!mark) return line;
  if (line.givenUp) {
    return onLineOf(mark, line.givenUp) ? line : { typed: false, mark, givenUp: null };
  }
  return line.mark && sameMark(line.mark, mark) ? line : { ...line, mark };
}

/**
 * `lines` once a frame drew `panes`: a pane nothing was typed into since its
 * last Enter or Ctrl+C has its prompt marked where the frame shows one, and a
 * pane gone is dropped. `lines` itself when nothing changed.
 */
export function afterFrame(lines: PaneLines, panes: readonly TmuxPane[]): PaneLines {
  const next: Record<PaneId, PaneLine> = {};
  let changed = false;
  for (const pane of panes) {
    const line = lines[pane.tmuxId] ?? UNTOUCHED;
    const seen = withFrame(line, pane);
    if (seen !== line) changed = true;
    if (seen !== UNTOUCHED) next[pane.tmuxId] = seen;
  }
  return changed || Object.keys(next).length !== Object.keys(lines).length ? next : lines;
}

/** Whether `pane` looks like it sits at an empty prompt: its cursor at the mark, the same text before it. */
export function looksEmpty(line: PaneLine | undefined, pane: TmuxPane | undefined): boolean {
  if (!line?.mark || !pane) return false;
  const now = promptMarkOf(pane);
  return now !== null && sameMark(now, line.mark);
}
