/**
 * Questions on a pane: pending sends (the pane side of `tmuxy pane send` into
 * someone else's pane), a restore's offers, and the questions a script or an
 * agent asks the person (`tmuxy pane ask`).
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
 * `tmuxy pane ask` writes `kind: "question"` with the question and either its
 * choices or `text: true`, and reads back `<token>:choice:<n>`,
 * `<token>:text:<base64>` or `<token>:no` (`questionAnswer`). The protocol's
 * one writer is `packages/tmuxy-core/src/ask/prompt.rs`.
 */

import type { TmuxPane } from './client';
import { decodeBase64Text, encodeBase64Text } from './base64';
import { QUESTION_LIMITS } from './tmuxyConstants.gen';

export interface SendAsk {
  kind: 'send';
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

/**
 * A command a session restore offers to run again in a pane it brought back
 * (`tmuxy-core`'s `offer_payload`). No process waits on it: the client that
 * answers runs it (yes) or drops it (no) itself. Drawn as a one-line banner.
 */
export interface OfferAsk {
  kind: 'offer';
  token: string;
  command: string;
}

/**
 * A question a script or an agent asks the person (`tmuxy pane ask`), which
 * waits for the answer and prints it. Drawn over the pane as a send is.
 */
export interface QuestionAsk {
  kind: 'question';
  token: string;
  /** Who asks: the program in front in the asker's pane, or its process. */
  caller: string;
  question: string;
  /** One button each, in order; empty for a text question. */
  choices: string[];
  /** One line of text and Submit instead of buttons. */
  text: boolean;
}

export type PaneAsk = SendAsk | OfferAsk | QuestionAsk;

/** What the user chose. Written back as `<token>:<answer>`. */
export type AskAnswer = 'yes' | 'no';

/** A send question's answers, in the order they are shown. */
export const SEND_ANSWERS: readonly AskAnswer[] = ['yes', 'no'];

/** How a question was answered: a choice by its place, a line typed, or dismissed. */
export type QuestionReply = { choice: number } | { text: string } | 'dismiss';

/**
 * A question's token: `<pane>-<pid>-<n>`, `restore-<window>-<pane>`, or
 * a pane id after `restore-`. One word, which `quote` keeps one argument.
 */
const ASK_TOKEN = /^[\w.%-]+$/;

/**
 * Null for anything that is not a well-formed payload (an unset option, a
 * value caught half-written): a malformed option must never blur a pane behind
 * an overlay the user cannot dismiss.
 */
export function decodePaneAsk(raw: string | null | undefined): PaneAsk | null {
  if (!raw) return null;
  let json: string;
  try {
    json = decodeBase64Text(raw.trim());
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const fields = parsed as Record<string, unknown>;
    const { token, kind, caller, keys, command } = fields;
    // The token is written back into a tmux command; one that is not a plain
    // word is not one tmuxy's `send` or a session restore wrote.
    if (typeof token !== 'string' || !ASK_TOKEN.test(token)) return null;
    if (kind === 'offer') {
      if (typeof command !== 'string' || !command) return null;
      return { kind: 'offer', token, command };
    }
    if (kind === 'question') return decodeQuestion(token, fields);
    if (!Array.isArray(keys) || keys.length === 0) return null;
    if (!keys.every((key): key is string => typeof key === 'string')) return null;
    return {
      kind: 'send',
      token,
      caller: typeof caller === 'string' && caller ? caller : 'a script',
      keys,
    };
  } catch {
    return null;
  }
}

export function paneAskFor(pane: Pick<TmuxPane, 'paneAsk'> | undefined | null): PaneAsk | null {
  return decodePaneAsk(pane?.paneAsk);
}

export function paneSendFor(pane: Pick<TmuxPane, 'paneAsk'> | undefined | null): SendAsk | null {
  const ask = paneAskFor(pane);
  return ask?.kind === 'send' ? ask : null;
}

export function paneOfferFor(pane: Pick<TmuxPane, 'paneAsk'> | undefined | null): OfferAsk | null {
  const ask = paneAskFor(pane);
  return ask?.kind === 'offer' ? ask : null;
}

/**
 * The question drawn over a pane, blurring it and taking its keys: a send or
 * a `tmuxy pane ask`, never an offer (a one-line banner the pane stays live
 * under). A pane holding one needs the user.
 */
export function paneOverlayAskFor(
  pane: Pick<TmuxPane, 'paneAsk'> | undefined | null,
): SendAsk | QuestionAsk | null {
  const ask = paneAskFor(pane);
  return ask && ask.kind !== 'offer' ? ask : null;
}

/** How many answers a question drawn over a pane offers to highlight. */
export function askAnswerCount(ask: SendAsk | QuestionAsk): number {
  return ask.kind === 'send' ? SEND_ANSWERS.length : ask.choices.length;
}

/**
 * The highlighted answer's place on a pane's question, from the app's
 * `askSelections`: the first until moved, and never past the last.
 */
export function askSelection(
  selections: Readonly<Record<string, number>>,
  paneId: string,
  count: number,
): number {
  return Math.min(selections[paneId] ?? 0, Math.max(0, count - 1));
}

/** C0, DEL and C1: what would let free text move the cursor or start an escape. */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** Free text from a script, as the overlay shows it: no control characters, cut at `max`. */
function plainText(text: string, max: number): string {
  return [...text]
    .filter((ch) => !isControl(ch))
    .slice(0, max)
    .join('');
}

/**
 * A question as `tmuxy pane ask` wrote it, held to its caps
 * (`QUESTION_LIMITS`, from `ask/prompt.rs`): anything on the socket can write
 * the option, so a longer one is cut here too rather than stretching the
 * overlay out of its pane.
 */
function decodeQuestion(token: string, fields: Record<string, unknown>): QuestionAsk | null {
  const { caller, question, choices, text } = fields;
  if (typeof question !== 'string' || !question.trim()) return null;
  const isText = text === true;
  // A choice is answered by its place, so one that cannot be shown voids the
  // question rather than shifting the ones after it.
  const words = isText ? [] : Array.isArray(choices) ? choices : [];
  if (!isText && words.length === 0) return null;
  if (!words.every((choice): choice is string => typeof choice === 'string' && !!choice.trim()))
    return null;
  const shown = words
    .slice(0, QUESTION_LIMITS.choices)
    .map((choice) => plainText(choice, QUESTION_LIMITS.choiceChars));
  const by = typeof caller === 'string' ? plainText(caller, QUESTION_LIMITS.callerChars) : '';
  return {
    kind: 'question',
    token,
    caller: by || 'a script',
    question: plainText(question, QUESTION_LIMITS.questionChars),
    choices: shown,
    text: isText,
  };
}

/** A question's answer as `@tmuxy-ask-answer` carries it, after `<token>:`. */
export function questionAnswer(reply: QuestionReply): string {
  if (reply === 'dismiss') return 'no';
  if ('choice' in reply) return `choice:${reply.choice}`;
  return `text:${encodeBase64Text(reply.text.slice(0, QUESTION_LIMITS.answerChars))}`;
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

const INLINE_MAX_CHARS = 48;

export function sentTextIsLong(text: string): boolean {
  return text.includes('\n') || text.length > INLINE_MAX_CHARS;
}
