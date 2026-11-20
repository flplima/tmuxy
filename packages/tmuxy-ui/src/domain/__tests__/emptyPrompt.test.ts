/**
 * What Ctrl+C takes for an empty shell prompt (`domain/emptyPrompt.ts`): the
 * prompt is marked while nothing is typed, and the line is empty again only
 * with the cursor back at the mark and the same text before it.
 */

import { describe, it, expect } from 'vitest';
import {
  afterFrame,
  afterInput,
  inputOf,
  isShellCommand,
  looksEmpty,
  type PaneLines,
} from '../emptyPrompt';
import { TmuxOp } from '../commands';
import type { TmuxPane } from '../client';
import { PaneId, WindowId } from '../ids';
import { cellLine, modelPane } from '../../test/model';

const P = PaneId.make('%3');
const W = WindowId.make('@1');

/** Pane %3 showing `rows`, its cursor at the end of the last one, running `command`. */
function screen(rows: string[], command = 'bash'): TmuxPane {
  const last = rows.length - 1;
  return modelPane(P, W, {
    command,
    content: rows.map(cellLine),
    cursorY: last,
    cursorX: rows[last]?.length ?? 0,
  });
}

/** Lines after each frame in turn. */
function frames(lines: PaneLines, ...shown: TmuxPane[]): PaneLines {
  return shown.reduce((acc, pane) => afterFrame(acc, [pane]), lines);
}

const type = (lines: PaneLines) => afterInput(lines, P, 'types');
const end = (lines: PaneLines) => afterInput(lines, P, 'ends');
const empty = (lines: PaneLines, pane: TmuxPane) => looksEmpty(lines[P], pane);

describe('an empty prompt', () => {
  it('is the prompt a pane draws before anything is typed: a split pane closes on its first Ctrl+C', () => {
    const prompt = screen(['$ ']);
    expect(empty(frames({}, prompt), prompt)).toBe(true);
    expect(empty({}, prompt)).toBe(false);
  });

  it('comes back when what was typed is deleted again, not with a line recalled from history', () => {
    const prompt = screen(['$ ']);
    let lines = type(frames({}, prompt));
    // The echo of what is typed is not a prompt: the mark stays where it was.
    lines = frames(lines, screen(['$ ls']));
    expect(empty(lines, screen(['$ ls']))).toBe(false);
    expect(empty(lines, prompt)).toBe(true);
    expect(empty(lines, screen(['$ git status']))).toBe(false);
  });

  it('is not a program in front, nor a row with nothing before the cursor', () => {
    expect(empty(frames({}, screen(['$ '], 'sleep')), screen(['$ '], 'sleep'))).toBe(false);
    const running = screen(['$ sleep 9', '']);
    expect(empty(frames({}, running), running)).toBe(false);
    const prompt = screen(['$ ']);
    expect(empty(frames({}, prompt), { ...prompt, alternateOn: true })).toBe(false);
    expect(empty(frames({}, prompt), { ...prompt, command: 'vim' })).toBe(false);
  });

  it('after Enter is the next prompt drawn, never the line that was given up', () => {
    let lines = type(frames({}, screen(['$ '])));
    lines = end(frames(lines, screen(['$ sleep 9'])));
    // A frame drawn before Enter reached the shell still shows the line: a
    // Ctrl+C then must interrupt the program it starts, not send it EOF.
    lines = frames(lines, screen(['$ sleep 9']));
    expect(empty(lines, screen(['$ sleep 9']))).toBe(false);
    // An Enter at the empty prompt that follows changes nothing of that.
    lines = frames(end(lines), screen(['$ sleep 9']));
    expect(empty(lines, screen(['$ sleep 9']))).toBe(false);
    const next = screen(['$ sleep 9', '$ ']);
    lines = frames(lines, next);
    expect(empty(lines, next)).toBe(true);
  });

  it('after Ctrl+C on a typed line is the fresh prompt, even on the same row', () => {
    let lines = type(frames({}, screen(['$ '])));
    lines = end(lines);
    expect(empty(frames(lines, screen(['$ git st'])), screen(['$ git st']))).toBe(false);
    expect(empty(frames(lines, screen(['$ '])), screen(['$ ']))).toBe(true);
  });

  it('forgets a pane tmux no longer has', () => {
    const lines = type(frames({}, screen(['$ '])));
    expect(afterFrame(lines, [])).toEqual({});
  });
});

describe('what an op does to a line', () => {
  it('Enter and Ctrl+C end it; keys, text and a paste type into it; a pane-less target is no line', () => {
    expect(inputOf(TmuxOp.SendKeys({ target: P, keys: 'Enter' }))).toEqual({
      paneId: P,
      input: 'ends',
    });
    expect(inputOf(TmuxOp.SendKeys({ target: P, keys: 'C-c' }))?.input).toBe('ends');
    expect(inputOf(TmuxOp.InterruptOrEof({ paneId: P }))?.input).toBe('ends');
    expect(inputOf(TmuxOp.SendKeys({ target: P, keys: 'Up' }))?.input).toBe('types');
    expect(inputOf(TmuxOp.SendText({ target: P, text: 'ls' }))?.input).toBe('types');
    expect(inputOf(TmuxOp.PasteText({ target: P, text: 'ls' }))?.input).toBe('types');
    expect(inputOf(TmuxOp.SendKeys({ target: P, keys: '-X cancel' }))).toBeNull();
    expect(inputOf(TmuxOp.SendKeys({ target: 'main', keys: 'a' }))).toBeNull();
    expect(inputOf(TmuxOp.KillPane({ paneId: P }))).toBeNull();
  });

  it('knows a shell by core’s names, a login shell’s dash and a path dropped', () => {
    expect(['zsh', '-zsh', '/bin/bash', 'fish'].map(isShellCommand)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['sleep', 'nvim', 'bashtop', ''].map(isShellCommand)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
