/**
 * A review of a diff: comments on its lines, sent to the agent as one
 * numbered prompt (`components/widgets/diff`).
 */

import type { TmuxPane } from './client';
import type { DiffScope } from './diff';
import { waitsForAnswer } from './paneState';

/** Which side of the diff a line number counts in. */
export type LineSide = 'new' | 'old';

export interface ReviewComment {
  path: string;
  side: LineSide;
  line: number;
  /** The line commented on, as the diff showed it. */
  code: string;
  body: string;
}

/** What a comment is stored under: one per line of a file. */
export function commentKey(path: string, side: LineSide, line: number): string {
  return `${side}:${line}:${path}`;
}

const SCOPE_WORDS: Record<DiffScope, string> = {
  unstaged: 'the unstaged changes',
  staged: 'the staged changes',
  branch: "the branch's changes",
};

/**
 * The comments as one prompt, numbered, each with where it is and the line it
 * is about: `1. src/cart.js:3 — …`. A comment on a removed line names the
 * old file's number.
 */
export function reviewPrompt(
  checkout: string,
  scope: DiffScope,
  comments: readonly ReviewComment[],
): string {
  const items = comments.map((comment, index) => {
    const where = `${comment.path}:${comment.line}${comment.side === 'old' ? ' (removed line)' : ''}`;
    const body = comment.body.trim().replace(/\n+/g, ' ');
    const code = comment.code.trim();
    return `${index + 1}. ${where} — ${body}${code ? `\n   > ${code}` : ''}`;
  });
  return `Review of ${SCOPE_WORDS[scope]} in ${checkout}:\n\n${items.join('\n')}`;
}

/**
 * Why a review may not be sent to `pane` now, or null when it may.
 *
 * Nothing here may answer a question: a pane whose agent waits for the user
 * (a permission prompt, a question) gets nothing typed into
 * it, since the prompt's first line would be taken as the answer. This is the
 * one place that decides; it gives way to `tmuxy pane send --wait`'s own
 * refusal when that lands.
 */
export function sendRefusal(
  pane: Pick<TmuxPane, 'tmuxId' | 'paneState' | 'paneAsk'> | undefined,
): string | null {
  if (!pane) return 'that pane is gone: nothing was sent';
  if (waitsForAnswer(pane)) {
    return `${pane.tmuxId} is waiting for your answer: answer it first, nothing was sent`;
  }
  return null;
}

/** The pane `tmuxy widget diff --to %N` named, from the widget's lines. */
export function namedTarget(lines: readonly string[]): string | null {
  const line = lines.find((l) => /^to:%\d+$/.test(l.trim()));
  return line ? line.trim().slice(3) : null;
}
