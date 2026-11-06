/**
 * Every event a backend host pushes, by the name it travels under — the same
 * on both transports (`HostEvent` in `tmuxy-core/src/host/event.rs`): an SSE
 * frame's `event:` on the web, a Tauri event's name on the desktop. Each name
 * has the schema its payload decodes with and the transport event it
 * becomes. Both drivers listen through this table, and the protocol fixture
 * test walks `packages/protocol-fixtures/events.json` against it, so a host
 * cannot emit an event no client reads.
 */

import { Either, Schema } from 'effect';
import {
  ClipboardEvent,
  ConnectionInfo,
  DetachedEvent,
  KeyBindings,
  LogEvent,
  MessageFrame,
  ThemeSettings,
  TmuxMessageEvent,
} from '../../domain/wire';
import { TransportEvent, type DriverEvent } from './events';
import { decodeWire, logProtocolError } from './wireDecode';

interface Spec<A, I> {
  readonly schema: Schema.Schema<A, I>;
  readonly toEvent: (payload: A) => DriverEvent;
}

const spec = <A, I>(
  schema: Schema.Schema<A, I>,
  toEvent: (payload: A) => DriverEvent,
): Spec<A, I> => ({ schema, toEvent });

export const HOST_EVENTS = {
  'connection-info': spec(ConnectionInfo, (info) =>
    TransportEvent.ConnectionInfo({
      defaultShell: info.default_shell ?? 'bash',
      hostname: info.hostname || null,
      traceEnabled: info.trace_enabled === true,
    }),
  ),
  // Decoded and sequenced by the stream stage (`stateFeed.ts`).
  'state-update': spec(
    Schema.Unknown,
    (payload): DriverEvent => ({ _tag: 'StateReceived', payload }),
  ),
  // Something for the user to read — never a statement about the link.
  'tmux-error': spec(MessageFrame, (data) =>
    TransportEvent.Error({ message: data.message || 'Unknown error' }),
  ),
  // The host's tmux connection ended or failed and is being retried; what
  // that means for the link is the driver's (see TauriAdapter).
  reconnecting: spec(MessageFrame, (data) =>
    TransportEvent.Log({ kind: 'error', message: data.message }),
  ),
  keybindings: spec(KeyBindings, (keybindings) => TransportEvent.KeyBindings({ keybindings })),
  'theme-settings': spec(ThemeSettings, (settings) => TransportEvent.ThemeSettings({ settings })),
  'css-changed': spec(Schema.NullOr(Schema.Unknown), () => TransportEvent.CssChanged()),
  log: spec(LogEvent, (data) => TransportEvent.Log({ kind: data.kind, message: data.message })),
  fatal: spec(MessageFrame, (data) =>
    TransportEvent.Fatal({ message: data.message || 'tmux unavailable' }),
  ),
  detached: spec(DetachedEvent, (data) => TransportEvent.Detached({ reason: data.reason ?? null })),
  clipboard: spec(ClipboardEvent, (data) =>
    TransportEvent.Clipboard({ paneId: data.pane_id, text: data.text }),
  ),
  'tmux-message': spec(TmuxMessageEvent, (data) => TransportEvent.Message({ text: data.text })),
};

export type HostEventName = keyof typeof HOST_EVENTS;

export const HOST_EVENT_NAMES = Object.keys(HOST_EVENTS) as HostEventName[];

export type HostEventPayload<K extends HostEventName> = Schema.Schema.Type<
  (typeof HOST_EVENTS)[K]['schema']
>;

/** What a driver does on an event besides publishing it: its link's own reaction. */
export type HostEventHooks = {
  readonly [K in HostEventName]?: (payload: HostEventPayload<K>) => void;
};

/**
 * Decode `raw` as the event `name`, run the driver's hook for it, and hand
 * back the transport event to publish; `null` (logged) when the payload does
 * not match its schema.
 */
export function receiveHostEvent<K extends HostEventName>(
  name: K,
  raw: unknown,
  hooks: HostEventHooks,
): DriverEvent | null {
  const event = HOST_EVENTS[name] as unknown as Spec<HostEventPayload<K>, unknown>;
  return Either.match(decodeWire(event.schema, name)(raw), {
    onLeft: (error) => {
      logProtocolError(error);
      return null;
    },
    onRight: (payload) => {
      const hook = hooks[name] as ((payload: HostEventPayload<K>) => void) | undefined;
      hook?.(payload);
      return event.toEvent(payload);
    },
  });
}
