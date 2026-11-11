import { EventHub } from '../../eventHub';
import { type DriverEvent } from '../events';
import { CommandFailure, ConnectionInfo } from '../../../domain/wire';
import { HOST_EVENT_NAMES, receiveHostEvent, type HostEventHooks } from '../hostEvents';
import { buildEndpointUrl } from '../endpoint';
import { Effect, Schedule, Schema } from 'effect';

/**
 * Reconnection backoff: retry forever, exponential from 1s, capped at 30s.
 *
 * `Schedule.either` recurs while EITHER input recurs and takes the SHORTER of
 * the two delays — so the exponential (1s, 2s, 4s, …) is clamped by the
 * constant 30s spacing, and the constant's infinite recurrence keeps the loop
 * retrying until the connection is re-established or the fiber is interrupted.
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
const STREAM_EVENTS = ['ping', ...HOST_EVENT_NAMES];

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

export type EstablishProbeOutcome = { kind: 'fatal'; message: string } | { kind: 'created' } | null;

/** The request guard's 403, with its reason, as the message the app shows. */
async function pageRefusal(response: Response): Promise<EstablishProbeOutcome> {
  const reason = (await response.text()).trim().replace(/^forbidden:\s*/i, '');
  return { kind: 'fatal', message: `The server refused this page${reason ? `: ${reason}` : ''}` };
}

/**
 * Find out why the event stream would not open. `EventSource` hides the
 * response, so a server that refuses every request looks exactly like one
 * that is not there yet, and the app would sit on "Connecting…" forever,
 * retrying something that cannot succeed.
 *
 * - A 403 is the request guard's verdict on this page's Host or origin, with
 *   the reason in the body; that ends retrying and is shown.
 * - A 404 means `?session=` does not exist yet (`GET /events` never creates
 *   sessions on its own): ask `POST /commands` (`ensure_session`) to create it
 *   and tell the caller to reconnect immediately. Its refusal (too many
 *   sessions) ends retrying and is shown, like a 403.
 */
export async function probeRefusalReason(
  eventsUrl: string,
  session: string,
  signal: AbortSignal,
  isConnected: () => boolean,
): Promise<EstablishProbeOutcome> {
  const response = await fetch(eventsUrl, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (isConnected()) return null;
  if (response.status === 403) return pageRefusal(response);
  if (response.status === 404) {
    const created = await fetch(buildEndpointUrl('/commands', session), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'ensure_session', args: {} }),
      signal,
    });
    if (isConnected()) return null;
    if (created.ok) return { kind: 'created' };
    if (created.status === 403) return pageRefusal(created);
    // The server's own refusal — a bad name, or as many sessions as it will
    // create (a 503) — is an answer; any other failure is an outage.
    const body: unknown = await created.json().catch(() => null);
    if (isCommandFailure(body)) {
      return { kind: 'fatal', message: `The server refused this session: ${body.error}` };
    }
  }
  return null;
}

export async function postCommandJson(
  session: string,
  connectionId: number,
  cmd: string,
  args: unknown,
  actionId?: string,
  commandSeq?: number,
): Promise<unknown> {
  const commandsUrl = buildEndpointUrl('/commands', session);
  const response = await fetch(commandsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Connection-Id': String(connectionId),
      // Correlate the request leg in the trace (docs/TRACING.md).
      ...(actionId ? { 'X-Action-Id': actionId } : {}),
      // The server runs this connection's numbered commands in number
      // order, whatever order they arrive in (S7 in docs/INVARIANTS.md).
      ...(commandSeq === undefined ? {} : { 'X-Command-Seq': String(commandSeq) }),
    },
    body: JSON.stringify({ cmd, args }),
  });

  if (!response.ok) {
    // The server's refusal is a `{ error, kind }` body, thrown as is so the
    // Effect facade tags it by kind (see AdapterError). Any other body — a
    // reverse-proxy 502 page, a 401 auth challenge — surfaces as the HTTP
    // status, not a JSON SyntaxError from parsing HTML.
    const body: unknown = await response.json().catch(() => null);
    throw isCommandFailure(body) ? body : new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as { result?: unknown };
  return data.result;
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

/** Fire-and-forget: a failed ship drops the batch, never affecting the app. */
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
  onFatal(): void;
  onEstablishError(eventsUrl: string): void;
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

    const hooks: HostEventHooks = {
      'connection-info': (data) => cb.onConnected(data),
      // The backend gave up: terminal state, no more events. The flag the
      // retry loop checks is set first, so the loop stops instead of
      // reconnecting into a dead backend.
      fatal: (data) => {
        cb.onFatal();
        endConnection(new Error(data.message || 'tmux unavailable'));
      },
    };

    // Every frame is `{ event, data }` JSON; `data` is decoded against its
    // event's schema (`hostEvents.ts`) and only a payload that matched is
    // published.
    for (const name of HOST_EVENT_NAMES) {
      es.addEventListener(name, (event: MessageEvent) => {
        const published = receiveHostEvent(name, parseFrame(name, event), hooks);
        if (published) cb.events.emit(published);
      });
    }

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
