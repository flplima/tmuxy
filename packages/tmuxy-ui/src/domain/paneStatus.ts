/**
 * What a pane's program said behind its state, with the program status
 * protocol (OSC 7501): the question it is blocked on, how far along it is.
 *
 * The host reads the report out of the pane's output, checks it against the
 * protocol's limits and keeps the record the pane shows in tmux, as a report
 * body: `@tmuxy-pane-status`, `state=blocked:kind=permission:msg=<base64>`.
 * It arrives as `pane_status`, and this is the client's reading of it. The
 * text came from a program, and the option is one anything can set, so it is
 * shown as text only: a control character drops it, and the characters that
 * change a line's direction or hide in it are taken out.
 */

import { decodeBase64Text } from './base64';
import type { TmuxPane } from './client';
import { PANE_STATE_LABEL, readPaneState, type PaneStateName } from './paneState';

export type PaneStatusKind = 'permission' | 'question' | 'auth';

export interface PaneStatus {
  /** What a blocked program waits for. */
  kind?: PaneStatusKind;
  /** 0 to 100. */
  progress?: number;
  /** The program's stable name (`cargo`, `terraform`). */
  app?: string;
  /** A label for the record, when the program reports several. */
  title?: string;
  /** One line: what the program is doing, waiting for or finished. */
  msg?: string;
}

/** As long as a tooltip stays one glance: the protocol allows 2048 bytes. */
const MAX_SHOWN_CHARS = 240;

const KINDS = new Set<string>(['permission', 'question', 'auth']);
/** C0, DEL and C1: a report holding one is not a line of text. */
const isControl = (code: number) => code <= 0x1f || (code >= 0x7f && code <= 0x9f);
/** Direction marks, overrides and isolates, zero-width characters, the BOM. */
const isInvisible = (code: number) =>
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x2069) ||
  code === 0xfeff;

function readText(encoded: string | undefined): string | undefined {
  if (!encoded) return undefined;
  let text: string;
  try {
    text = decodeBase64Text(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return undefined;
  }
  const codes = Array.from(text, (ch) => ch.codePointAt(0) ?? 0);
  if (codes.some(isControl)) return undefined;
  const shown = String.fromCodePoint(...codes.filter((code) => !isInvisible(code))).trim();
  if (!shown) return undefined;
  return shown.length > MAX_SHOWN_CHARS ? `${shown.slice(0, MAX_SHOWN_CHARS - 1)}\u2026` : shown;
}

export function readPaneStatus(raw: string | null | undefined): PaneStatus | null {
  if (!raw) return null;
  const pairs = new Map<string, string>();
  for (const pair of raw.split(':')) {
    const at = pair.indexOf('=');
    if (at > 0) pairs.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const kind = pairs.get('kind');
  const progress = pairs.get('progress');
  const percent = progress && /^\d{1,3}$/.test(progress) ? Number(progress) : undefined;
  return {
    kind: kind && KINDS.has(kind) ? (kind as PaneStatusKind) : undefined,
    progress: percent !== undefined && percent <= 100 ? percent : undefined,
    app: pairs.get('app') || undefined,
    title: readText(pairs.get('title')),
    msg: readText(pairs.get('msg')),
  };
}

const BLOCKED_LABEL: Record<PaneStatusKind, string> = {
  permission: 'Needs your approval',
  question: 'Needs your answer',
  auth: 'Needs you to sign in',
};

/**
 * What a state mark says when pointed at: the state, and what the program
 * said behind it. `state` is the state the mark draws, which a pending send's
 * question can raise above the program's own, so the program's words are used
 * only when the state is its own.
 */
export function paneStateLabel(
  state: PaneStateName,
  pane: Pick<TmuxPane, 'paneState' | 'paneStatus'>,
): string {
  const status = readPaneState(pane.paneState) === state ? readPaneStatus(pane.paneStatus) : null;
  if (!status) return PANE_STATE_LABEL[state];
  // Only a blocked program's record carries a kind.
  let label = status.kind ? BLOCKED_LABEL[status.kind] : PANE_STATE_LABEL[state];
  if (status.progress !== undefined) label += ` ${status.progress}%`;
  const said = [status.title, status.msg].filter(Boolean).join(': ');
  return said ? `${label}: ${said}` : label;
}
