/**
 * Pending sends — the pane side of `tmuxy pane send` into someone else's pane.
 *
 * `tmuxy pane send -t %3 'npm test' Enter`, run from another pane, does not
 * send the keys. It writes a question to the target pane's `@tmuxy-ask`
 * option and blocks; the pane draws the question over its own blurred
 * content, and whatever the user answers is written back to
 * `@tmuxy-ask-answer`, which the waiting CLI reads before it sends the keys
 * (yes) or gives up (no). The point of the round trip is that the sender —
 * usually an agent in another pane — learns exactly when the command started,
 * so it knows when the output is worth capturing.
 *
 * The option's value is base64 of a JSON object rather than the text itself:
 * `list-panes` rows are comma-separated, and the keys are free text. Base64
 * cannot contain a comma, so the payload rides the format unescaped no matter
 * what the keys say.
 *
 * Pure: no React, no machine, no adapter.
 */

import type { TmuxPane } from '../domain/client';

/** A send waiting on a pane for the user's answer. */
export interface PaneAsk {
  /**
   * Identifies the question, so an answer can be pinned to the one that was on
   * screen. A question withdrawn and replaced while the user was reading gets
   * a new token, and the stale answer is ignored rather than acted on.
   */
  token: string;
  /** Who wants to send: the program in front in the sender's pane. */
  caller: string;
  /** The `send-keys` arguments, verbatim: literal text and key names. */
  keys: string[];
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
    // emoji in the keys) has to be decoded as UTF-8 rather than read off as
    // Latin-1.
    const bytes = Uint8Array.from(atob(raw.trim()), (ch) => ch.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const { token, caller, keys } = parsed as Record<string, unknown>;
    if (typeof token !== 'string' || !token) return null;
    if (!Array.isArray(keys) || keys.length === 0) return null;
    if (!keys.every((key): key is string => typeof key === 'string')) return null;
    return { token, caller: typeof caller === 'string' && caller ? caller : 'a script', keys };
  } catch {
    return null;
  }
}

/** The question waiting on a pane, or null when none is. */
export function paneAskFor(pane: Pick<TmuxPane, 'paneAsk'> | undefined | null): PaneAsk | null {
  return decodePaneAsk(pane?.paneAsk);
}

/** Key names `send-keys` turns into a character rather than a chord. */
const KEY_TEXT: Record<string, string> = {
  Enter: '\n',
  'C-m': '\n',
  KPEnter: '\n',
  Space: ' ',
  Tab: '\t',
};

/** An argument `send-keys` reads as a key name rather than as text. */
const KEY_NAME =
  /^(?:(?:[CMS]-)+\S+|Escape|BSpace|BTab|Up|Down|Left|Right|Home|End|PageUp|PageDown|PgUp|PgDn|PPage|NPage|IC|DC|Insert|Delete|F\d{1,2})$/;

/**
 * What the keys type, as the user would read it: arguments joined with
 * nothing between them (as `send-keys` sends them), `Enter` as a line break,
 * any other key name as `‹C-c›`. The Enter that ends the last line is what
 * runs it, so it is not shown as an empty line of its own.
 */
export function sentText(keys: readonly string[]): string {
  const text = keys.map((key) => KEY_TEXT[key] ?? (KEY_NAME.test(key) ? `‹${key}›` : key)).join('');
  return text.replace(/\n$/, '');
}

/** Past this, or on more than one line, the keys get a block of their own. */
const INLINE_MAX_CHARS = 48;

/** Whether the keys read inline in the question or need their own block. */
export function sentTextIsLong(text: string): boolean {
  return text.includes('\n') || text.length > INLINE_MAX_CHARS;
}
