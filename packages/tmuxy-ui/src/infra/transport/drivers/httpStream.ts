import { EventHub } from '../../eventHub';
import { TransportEvent, type DriverEvent } from '../events';
import {
  ClipboardEvent,
  CommandFailure,
  ConnectionInfo,
  DetachedEvent,
  KeyBindings,
  LogEvent,
  MessageFrame,
  ThemeSettings,
  TmuxMessageEvent,
} from '../../../domain/wire';
import { decodeEvent } from '../wireDecode';
import { tracer } from '../../tracer';
import { Effect, Schedule, Schema } from 'effect';

/**
 * Reconnection backoff: retry forever, exponential from 1s, capped at 30s.
 *
 * `Schedule.either` recurs while EITHER input recurs and takes the SHORTER of
 * the two delays — so the exponential (1s, 2s, 4s, …) is clamped by the
 * constant 30s spacing, and the constant's infinite recurrence keeps the loop
 * retrying indefinitely until the connection is re-established or the fiber is
 * interrupted. Modelling reconnection as an Effect Schedule (rather than a
 * hand-rolled setTimeout + flag machine) means "keep retrying with backoff"
 * is the schedule's definition — an establish-failure and a mid-session drop
 * are the same program failure, so neither can silently end the retry loop.
 */
export const RECONNECT_SCHEDULE = Schedule.exponential('1 seconds').pipe(
  Schedule.either(Schedule.spaced('30 seconds')),
);

/** A connection that had been established ended — as opposed to one that never opened. */
export class ConnectionDropped extends Error {}

/** A beat before reopening a dropped stream, so a server that accepts and drops cannot spin us. */
export const REOPEN_AFTER_DROP_MS = 250;

/** Quiet for this long on a stream the server pings every second means it is gone. */
const STREAM_SILENCE_MS = 5000;

/** Every event the server sends; any of them shows the stream is alive. */
const STREAM_EVENTS = [
  'ping',
  'connection-info',
  'state-update',
  'keybindings',
  'theme-settings',
  'css-changed',
  'tmux-error',
  'clipboard',
  'tmux-message',
  'log',
  'detached',
  'fatal',
] as const;

export const isCommandFailure = Schema.is(CommandFailure);

/** The `data` of an SSE frame (`{ event, data }` JSON); undefined when the frame is not JSON. */
export function parseFrame(type: string, event: MessageEvent): unknown {
  try {
    return (JSON.parse(event.data) as { data?: unknown }).data;
  } catch (e) {
    console.error(`Failed to parse ${type} frame:`, e);
    return undefined;
  }
}

/**
 * Get the session name from URL query parameters.
 * Falls back to 'tmuxy' if not specified.
 */
export function getSessionFromUrl(): string {
  if (typeof window === 'undefined') return 'tmuxy';
  const params = new URLSearchParams(window.location.search);
  return params.get('session') || 'tmuxy';
}

export function buildEndpointUrl(path: string, session?: string): string {
  const protocol = window.location.protocol;
  const host = window.location.host || 'localhost:3853';
  const query = session !== undefined ? `?session=${encodeURIComponent(session)}` : '';
  return `${protocol}//${host}${path}${query}`;
}

/** The browser's own hints that a retry is worth making now rather than at the next backoff tick. */
export function installNetworkHints(onRetry: () => void): (() => void) | null {
  if (typeof window === 'undefined') return null;
  const retryWhenVisible = (): void => {
    if (document.visibilityState === 'visible') onRetry();
  };
  window.addEventListener('online', onRetry);
  document.addEventListener('visibilitychange', retryWhenVisible);
  return () => {
    window.removeEventListener('online', onRetry);
    document.removeEventListener('visibilitychange', retryWhenVisible);
  };
}

/**
 * Find out why the event stream would not open. `EventSource` hides the
 * response, so a server that refuses every request looks exactly like one
 * that is not there yet, and the app would sit on "Connecting…" forever,
 * retrying something that cannot succeed. A 403 is an answer, not an outage
 * — the request guard's verdict on this page's Host or origin, with the
 * reason in the body (a server behind a proxy started without
 * `--allowed-host` is the usual one). That ends the retrying and is shown.
 * Anything else — no answer, a 5xx, a stream that does open — keeps it going.
 */
export async function probeRefusalReason(
  eventsUrl: string,
  signal: AbortSignal,
  isConnected: () => boolean,
): Promise<string | null> {
  const response = await fetch(eventsUrl, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (response.status !== 403 || isConnected()) return null;
  const reason = (await response.text()).trim().replace(/^forbidden:\s*/i, '');
  return `The server refused this page${reason ? `: ${reason}` : ''}`;
}

export async function postCommandJson<T>(
  session: string,
  connectionId: number,
  cmd: string,
  args?: Record<string, unknown>,
  actionId?: string,
): Promise<T> {
  const commandsUrl = buildEndpointUrl('/commands', session);
  const response = await fetch(commandsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Connection-Id': String(connectionId),
      // Correlate the request leg in the trace (docs/TRACING.md).
      ...(actionId ? { 'X-Action-Id': actionId } : {}),
    },
    body: JSON.stringify({ cmd, args: args || {} }),
  });

  if (!response.ok) {
    // The server's refusal is a `{ error, kind }` body, thrown as is so the
    // Effect facade tags it by kind (see AdapterError). Any other body — a
    // reverse-proxy 502 page, a 401 auth challenge — surfaces as the HTTP
    // status, not a JSON SyntaxError from parsing HTML.
    const body: unknown = await response.json().catch(() => null);
    throw isCommandFailure(body) ? body : new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.result as T;
}

/**
 * Stage a preview pane's page (`POST /api/preview/{pane}`). A refusal is the
 * server's `{ error, kind }`, thrown as `postCommandJson` throws one.
 */
export async function postPreviewPage(url: string, html: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw isCommandFailure(body) ? body : new Error(`HTTP ${response.status}`);
  }
}

export function postCommandFireAndForgetEffect(
  session: string,
  connectionId: number,
  cmd: string,
  args: Record<string, unknown>,
  actionId?: string,
): Effect.Effect<void> {
  const commandsUrl = buildEndpointUrl('/commands', session);
  const connId = String(connectionId);
  return Effect.promise(() =>
    fetch(commandsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': connId,
        ...(actionId ? { 'X-Action-Id': actionId } : {}),
      },
      body: JSON.stringify({ cmd, args }),
    })
      .then(() => {})
      .catch(() => {}),
  );
}

/** Ship a batch of trace events to the same-origin /trace ingest endpoint.
 * Fire-and-forget: a failed ship drops the batch, never affecting the app. */
export function shipTraceBatch(connectionId: number, events: Record<string, unknown>[]): void {
  try {
    fetch(buildEndpointUrl('/trace'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': String(connectionId),
      },
      body: JSON.stringify(events),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // window/fetch unavailable (SSR/test) — drop silently.
  }
}

export interface SseStreamCallbacks {
  events: EventHub<DriverEvent>;
  onOpen(es: EventSource): void;
  onClose(es: EventSource): void;
  isConnected(): boolean;
  isStopRetrying(): boolean;
  onConnected(data: ConnectionInfo): void;
  onDisconnected(shouldAnnounceReconnect: boolean): void;
  onFatal(message: string): void;
  onEstablishError(eventsUrl: string): void;
  shipTrace(events: Record<string, unknown>[]): void;
}

/**
 * Open a single EventSource. The returned effect stays suspended for the
 * LIFETIME of that connection — its handlers fire side effects (events,
 * resolve waiters) while connected — and only completes, as a failure, when
 * the connection ends. Retrying it therefore reconnects. Its scoped finalizer
 * closes the stream on interruption (disconnect / session switch).
 */
export function openSseConnection(
  eventsUrl: string,
  cb: SseStreamCallbacks,
): Effect.Effect<never, Error> {
  return Effect.async<never, Error>((resume) => {
    const es = new EventSource(eventsUrl);
    cb.onOpen(es);

    // A link that dies silently — a sleeping laptop, a Wi-Fi roam, a proxy
    // that holds the socket open — raises no error for minutes. The server
    // pings an otherwise idle stream every second, so a connected stream
    // that has been quiet for several is gone. Armed only once a ping has
    // been seen: an older server sends comments, which never reach a page.
    let lastHeard = Date.now();
    let pinged = false;
    for (const type of STREAM_EVENTS) {
      es.addEventListener(type, () => {
        lastHeard = Date.now();
        if (type === 'ping') pinged = true;
      });
    }
    const watchdog = setInterval(() => {
      if (!pinged || !cb.isConnected()) return;
      if (Date.now() - lastHeard > STREAM_SILENCE_MS) {
        endConnection(new ConnectionDropped('SSE stream went silent'));
      }
    }, 1000);

    // End this connection exactly once: close the stream, mark disconnected,
    // announce reconnection (unless intentional/fatal), then fail the effect
    // so the retry schedule takes over.
    let ended = false;
    const endConnection = (error: Error): void => {
      if (ended) return;
      ended = true;
      clearInterval(watchdog);
      es.close();
      cb.onClose(es);
      cb.onDisconnected(!cb.isStopRetrying());
      resume(Effect.fail(error));
    };

    // Every frame is `{ event, data }` JSON; `data` is decoded against its
    // schema and the handler only ever sees a payload that matched.
    const on = <A, I>(
      type: (typeof STREAM_EVENTS)[number],
      schema: Schema.Schema<A, I>,
      handle: (data: A) => void,
    ): void => {
      const decode = decodeEvent(schema, type);
      es.addEventListener(type, (event: MessageEvent) => {
        const data = decode(parseFrame(type, event));
        if (data !== null) handle(data);
      });
    };

    on('connection-info', ConnectionInfo, (data) => {
      cb.onConnected(data);

      // Action tracing (docs/TRACING.md): the server tells us whether it
      // is recording; only then do we ship our own events, and only through
      // the same-origin /trace sink. The server independently rejects when
      // off, so this is a hint, not the gate.
      tracer.setServerEnabled(data.trace_enabled === true);
      tracer.setSink((events) => cb.shipTrace(events));
    });

    // Decoded and sequenced by the stream stage (`stateFeed.ts`).
    es.addEventListener('state-update', (event: MessageEvent) => {
      cb.events.emit({ _tag: 'StateReceived', payload: parseFrame('state-update', event) });
    });

    on('keybindings', KeyBindings, (keybindings) =>
      cb.events.emit(TransportEvent.KeyBindings({ keybindings })),
    );

    on('theme-settings', ThemeSettings, (settings) =>
      cb.events.emit(TransportEvent.ThemeSettings({ settings })),
    );

    es.addEventListener('css-changed', () => cb.events.emit(TransportEvent.CssChanged()));

    // Backend errors for the user (a rejected command, a failed sync). The
    // wire name is `tmux-error`, not `error`: a server event named `error`
    // also fires `es.onerror`, and every reported error would have bounced
    // the connection.
    on('tmux-error', MessageFrame, (data) =>
      cb.events.emit(TransportEvent.Error({ message: data.message || 'Unknown error' })),
    );

    // OSC 52 clipboard write requests from terminal applications.
    // Mirrored into the system clipboard via navigator.clipboard.writeText.
    on('clipboard', ClipboardEvent, (data) =>
      cb.events.emit(TransportEvent.Clipboard({ paneId: data.pane_id, text: data.text })),
    );

    // `display-message` output: the wire name is `tmux-message`, not
    // `message`, which every EventSource also dispatches to `onmessage`.
    on('tmux-message', TmuxMessageEvent, (data) =>
      cb.events.emit(TransportEvent.Message({ text: data.text })),
    );

    on('log', LogEvent, (data) =>
      cb.events.emit(TransportEvent.Log({ kind: data.kind, message: data.message })),
    );

    // The connection ended with tmux's own reason. Deliberately does NOT set
    // `this.fatal`: that flag stops the retry loop for good, and a detach is
    // something the user steps back from by reconnecting.
    on('detached', DetachedEvent, (data) =>
      cb.events.emit(TransportEvent.Detached({ reason: data.reason ?? null })),
    );

    // Backend gave up reconnecting — terminal state, no more events. Flip the
    // flag the retry `while` predicate checks so the loop stops instead of
    // reconnecting into a dead backend, then end the connection.
    on('fatal', MessageFrame, (data) => {
      const message = data.message || 'tmux unavailable';
      cb.onFatal(message);
      endConnection(new Error(message));
    });

    es.onerror = () => {
      const wasConnected = cb.isConnected();
      // A stream that never opened may have been REFUSED rather than missed:
      // EventSource reports both as the same bare error, so ask the server.
      if (!wasConnected) cb.onEstablishError(eventsUrl);
      // Establish failure and mid-session drop are the same to the retry
      // loop — end the connection and let the schedule pick the next attempt.
      endConnection(
        wasConnected
          ? new ConnectionDropped('SSE connection lost')
          : new Error('Failed to connect to SSE'),
      );
    };

    // Interrupt (disconnect / switchSession): close the stream we opened.
    return Effect.sync(() => {
      if (ended) return;
      ended = true;
      clearInterval(watchdog);
      es.close();
      cb.onClose(es);
    });
  });
}
