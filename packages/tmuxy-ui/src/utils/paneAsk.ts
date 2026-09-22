/**
 * Pending confirmations — the pane side of `tmuxy ask`.
 *
 * `tmuxy ask %3 npm test Enter` does not send the keys. It writes a question
 * to the target pane's `@tmuxy-ask` option and blocks; the pane draws the
 * question over its own blurred content, and whatever the user answers is
 * written back to `@tmuxy-ask-answer`, which the waiting CLI reads before it
 * sends the keys (yes) or gives up (no). The point of the round trip is that
 * the asker — usually an agent in another pane — learns exactly when the
 * command started, so it knows when the output is worth capturing.
 *
 * The option's value is base64 of a JSON object rather than the text itself:
 * `list-panes` rows are comma-separated, and a question is free text a user
 * wrote. Base64 cannot contain a comma, so the payload rides the format
 * unescaped no matter what the question says.
 *
 * Pure: no React, no machine, no adapter.
 */

import type { TmuxPane } from '../tmux/types';

/** A question waiting on a pane. */
export interface PaneAsk {
  /**
   * Identifies the question, so an answer can be pinned to the one that was on
   * screen. A question withdrawn and replaced while the user was reading gets
   * a new token, and the stale answer is ignored rather than acted on.
   */
  token: string;
  /** The question itself, e.g. `Do you want to send keys "npm test Enter"?`. */
  question: string;
  /** Optional detail, drawn smaller under the question. Empty when unset. */
  description: string;
}

/** What the user chose. Written back as `<token>:<answer>`. */
export type AskAnswer = 'yes' | 'no';

/**
 * Decode a raw `@tmuxy-ask` value.
 *
 * Returns null for anything that is not a well-formed payload — an unset
 * option, a truncated value, a half-written one caught mid-round-trip. A pane
 * with no readable question simply has no question: a malformed option must
 * never blur a pane behind an overlay the user cannot dismiss.
 */
export function decodePaneAsk(raw: string | null | undefined): PaneAsk | null {
  if (!raw) return null;
  let json: string;
  try {
    // atob yields one char per BYTE, so a multi-byte character (an accent, an
    // emoji in a question) has to be decoded as UTF-8 rather than read off as
    // Latin-1.
    const bytes = Uint8Array.from(atob(raw.trim()), (ch) => ch.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const { token, question, description } = parsed as Record<string, unknown>;
    if (typeof token !== 'string' || !token) return null;
    if (typeof question !== 'string' || !question) return null;
    return {
      token,
      question,
      description: typeof description === 'string' ? description : '',
    };
  } catch {
    return null;
  }
}

/** The question waiting on a pane, or null when none is. */
export function paneAskFor(pane: Pick<TmuxPane, 'paneAsk'> | undefined | null): PaneAsk | null {
  return decodePaneAsk(pane?.paneAsk);
}

/**
 * The tmux command that answers a question: clear it, then record the answer.
 *
 * Both halves go in one compound command so a client cannot leave the pane
 * showing an answered question. The clear comes first for the same reason —
 * the overlay is what the user is looking at, and it should come down the
 * instant they choose, not once the keys arrive.
 */
export function answerAskCommand(paneId: string, ask: PaneAsk, answer: AskAnswer): string {
  return (
    `set-option -pu -t ${paneId} @tmuxy-ask \\; ` +
    `set-option -p -t ${paneId} @tmuxy-ask-answer '${ask.token}:${answer}'`
  );
}
