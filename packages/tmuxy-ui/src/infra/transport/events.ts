/**
 * Everything a backend pushes to the client, as one tagged union in arrival
 * order. A driver emits these on its `EventHub`; the `TmuxTransport` service
 * publishes them on one stream, so a consumer sees a `ConnectionInfo` before
 * the `State` that followed it on the wire.
 */

import { Data } from 'effect';
import type { PaneId } from '../../domain/ids';
import type { KeyBindings, LogEntryKind, ServerState, ThemeSettings } from '../../domain/wire';

export type TransportEvent = Data.TaggedEnum<{
  /** A decoded, sequenced state; `seq` is the delta's (null for a full state). */
  State: { readonly state: ServerState; readonly seq: number | null };
  ConnectionInfo: {
    readonly defaultShell: string;
    /** The server runs `--read-only`: this client is a viewer. */
    readonly readOnly: boolean;
  };
  /** The channel dropped (true) or came back (false). */
  Reconnection: { readonly reconnecting: boolean };
  KeyBindings: { readonly keybindings: KeyBindings };
  /** Theme + appearance pushed after the config is (re)sourced. */
  ThemeSettings: { readonly settings: ThemeSettings };
  /** Connection-time log: each tmux command and its output. */
  Log: { readonly kind: LogEntryKind; readonly message: string };
  /** A backend error for the user (a rejected command, a failed sync). */
  Error: { readonly message: string };
  /** The backend gave up reconnecting; nothing follows. */
  Fatal: { readonly message: string };
  /** The connection ended with tmux's own `%exit` reason; not a failure. */
  Detached: { readonly reason: string | null };
  /** An OSC 52 clipboard write from a terminal application. */
  Clipboard: { readonly paneId: PaneId | null; readonly text: string };
}>;

export const TransportEvent = Data.taggedEnum<TransportEvent>();

/**
 * A `state-update` payload as it came off the wire, before the stream stage
 * decodes and sequences it into a `State` (`stateFeed.ts`).
 */
export interface StateReceived {
  readonly _tag: 'StateReceived';
  readonly payload: unknown;
}

/** What a driver whose stream needs sequencing (HTTP, Tauri) emits. */
export type DriverEvent = TransportEvent | StateReceived;
