import { fromCallback, type AnyActorRef } from 'xstate';
import { Cause, Effect, Exit, Fiber, Stream } from 'effect';
import { ScrollbackCells, ThemeSettings, type ServerState } from '../../domain/wire';
import type { TraceLevel, TraceSettings } from '../types';
import { formatAdapterError, type AdapterError } from '../../tmux/effect/AdapterError';
import { tracer } from '../../tmux/tracer';
import { isInputCommand, READ_ONLY_NOTICE, READ_ONLY_REASON } from '../../tmux/readOnly';
import type { PaneId } from '../../domain/ids';
import { toTmuxCommand, TmuxOp } from '../../domain/commands';
import type { AppRuntime } from '../../infra/runtime';
import { TmuxTransport, type TmuxTransportService } from '../../infra/transport/TmuxTransport';
import { TransportEvent } from '../../infra/transport/events';

/** An effect against the transport the runtime provides. */
const withTransport = <A, E>(
  f: (transport: TmuxTransportService) => Effect.Effect<A, E>,
): Effect.Effect<A, E, TmuxTransport> => Effect.flatMap(TmuxTransport, f);

export type TmuxActorEvent =
  /**
   * Run an op straight on the transport: no prediction, no op log. For the
   * machine's own bookkeeping (window tags, copy-mode exits, a float's close)
   * that nothing on screen waits for.
   */
  | { type: 'SEND_OP'; op: TmuxOp }
  | { type: 'INVOKE'; cmd: string; args?: Record<string, unknown> }
  | { type: 'FETCH_INITIAL_STATE'; cols: number; rows: number }
  | { type: 'FETCH_SCROLLBACK_CELLS'; paneId: PaneId; start: number; end: number }
  | { type: 'FETCH_THEME_SETTINGS' }
  | { type: 'FETCH_TRACE_SETTINGS' }
  | { type: 'SET_TRACE_ENABLED'; enabled: boolean }
  | { type: 'SET_TRACE_LEVEL'; level: TraceLevel }
  | { type: 'OPEN_TRACE_FILE' }
  | { type: 'FETCH_THEMES_LIST' }
  | { type: 'SWITCH_SESSION'; sessionName: string }
  | { type: 'RESTORE_SESSION'; sessionName: string }
  | { type: 'RECONNECT_NOW' }
  | { type: 'CHECK_SESSION_SWITCH' };

export interface TmuxActorInput {
  parent: AnyActorRef;
}

/**
 * Create the tmux actor over the app runtime's transport.
 *
 * Subscribes to the transport's event stream before connecting, forwards
 * each event to the parent, and runs the parent's requests as Effects. A
 * failure carries the AdapterError ADT: the actor branches on the tag (a
 * read-only refusal becomes a notice) and tunnels the rest back to the
 * parent as { type: 'TMUX_ERROR', error: <display string> }.
 */
export function createTmuxActor(runtime: AppRuntime) {
  return fromCallback<TmuxActorEvent, TmuxActorInput>(({ input, receive }) => {
    const { parent } = input;

    const logInfo = (message: string) => parent.send({ type: 'LOG_APPEND', kind: 'info', message });
    const logCommand = (message: string) =>
      parent.send({ type: 'LOG_APPEND', kind: 'command', message });
    const logError = (message: string) =>
      parent.send({ type: 'LOG_APPEND', kind: 'error', message });

    interface RunOptions<T> {
      onSuccess?: (value: T) => void;
      /** A context label for the LOG_APPEND error entry (e.g. the command). */
      logPrefix?: string;
      /** Log to the console only: a failure here is no UI error (e.g. a settings read). */
      silentFail?: boolean;
      /** Refused by a read-only session without a notice: input, or a write nobody asked for. */
      quietWhenReadOnly?: boolean;
    }

    /** `effect` with its outcome reported: onSuccess, or the failure sent to the parent. */
    const reported = <T>(
      effect: Effect.Effect<T, AdapterError, TmuxTransport>,
      opts: RunOptions<T>,
    ): Effect.Effect<void, never, TmuxTransport> =>
      Effect.flatMap(Effect.exit(effect), (exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) {
            opts.onSuccess?.(exit.value);
            return;
          }
          const failure = Cause.failureOption(exit.cause);
          if (failure._tag !== 'Some') return;
          const tagged = failure.value;
          // A write a read-only session never sent: the user asked for a change
          // they cannot make, which is not an error of the backend's.
          if (tagged._tag === 'Cancelled' && tagged.reason === READ_ONLY_REASON) {
            if (!opts.silentFail && !opts.quietWhenReadOnly) {
              parent.send({ type: 'NOTIFY', text: READ_ONLY_NOTICE });
            }
            return;
          }
          // Trace the failure by its typed tag (TransportError/ProtocolError/…),
          // never the message text.
          tracer.event({ layer: 'effect', name: 'fail', code: tagged._tag });
          const display = formatAdapterError(tagged);
          if (opts.silentFail) {
            console.error(
              `[tmuxActor] ${opts.logPrefix ?? 'effect'} failed:`,
              tagged._tag,
              display,
            );
            return;
          }
          if (opts.logPrefix) logError(`${opts.logPrefix} -> ${display}`);
          parent.send({ type: 'TMUX_ERROR', error: display });
        }),
      );

    const run = <T>(
      effect: Effect.Effect<T, AdapterError, TmuxTransport>,
      opts: RunOptions<T> = {},
    ): void => {
      runtime.runFork(reported(effect, opts));
    };

    /**
     * In-flight scrollback fetches keyed by paneId. Fast-scroll sends multiple FETCH_SCROLLBACK_CELLS in quick succession; without
     * cancellation, the responses race and stale results overwrite fresh
     * ones (or just waste bandwidth). Interrupting the previous fiber
     * before forking a new one keeps only the latest scroll position's
     * fetch alive — its result is the only one that reaches the parent.
     *
     * Promise cancellation isn't real (fetch in flight still completes),
     * but Fiber.interrupt stops the Effect from emitting onSuccess, so
     * the parent never sees the stale chunk.
     */
    const scrollbackFibers = new Map<PaneId, Fiber.RuntimeFiber<unknown>>();

    const themeSettingsReceived = (settings: ThemeSettings) =>
      parent.send({
        type: 'THEME_SETTINGS_RECEIVED',
        theme: settings.theme || 'default',
        mode: (settings.mode === 'light' ? 'light' : 'dark') as 'dark' | 'light',
        appearance: settings.appearance,
      });

    /** Each pushed event as the parent's event. */
    const forward = TransportEvent.$match({
      State: ({ state }) => parent.send({ type: 'TMUX_STATE_UPDATE', state }),
      Error: ({ message }) => {
        logError(message);
        parent.send({ type: 'TMUX_ERROR', error: message });
      },
      Log: ({ kind, message }) => parent.send({ type: 'LOG_APPEND', kind, message }),
      Fatal: ({ message }) => {
        logError(message);
        parent.send({ type: 'TMUX_FATAL', message });
      },
      // The connection ended, with tmux's own `%exit` reason.
      Detached: ({ reason }) => parent.send({ type: 'TMUX_DETACHED', reason }),
      // The channel dropped or recovered, so the UI can show a banner while
      // it is down and clear it on recovery.
      Reconnection: ({ reconnecting }) =>
        parent.send({ type: reconnecting ? 'TMUX_RECONNECTING' : 'TMUX_RECONNECTED' }),
      KeyBindings: ({ keybindings }) => parent.send({ type: 'KEYBINDINGS_RECEIVED', keybindings }),
      ThemeSettings: ({ settings }) => themeSettingsReceived(settings),
      ConnectionInfo: ({ defaultShell, readOnly }) =>
        parent.send({ type: 'CONNECTION_INFO', defaultShell, readOnly }),
      // OSC 52 clipboard requests from terminal applications.
      Clipboard: ({ paneId, text }) => parent.send({ type: 'TMUX_CLIPBOARD', paneId, text }),
    });

    logInfo('Connecting to tmux backend...');

    // Subscribe first, then connect: nothing the connection says is missed.
    const session = runtime.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* (yield* TmuxTransport).subscribe;
          yield* Effect.forkScoped(
            reported(
              withTransport((t) => t.connect),
              {
                onSuccess: () => {
                  logInfo('Connected to tmux backend');
                  parent.send({ type: 'TMUX_CONNECTED' });
                },
                logPrefix: 'Connect failed',
              },
            ),
          );
          yield* Stream.runForEachChunk(events, (chunk) =>
            Effect.sync(() => {
              for (const event of chunk) forward(event);
            }),
          );
        }),
      ),
    );

    receive((event) => {
      if (event.type === 'SEND_OP') {
        const command = toTmuxCommand(event.op);
        logCommand(command);
        run(
          withTransport((t) => t.invoke('run_tmux_command', { command })),
          {
            logPrefix: command,
            quietWhenReadOnly: isInputCommand(command),
          },
        );
      } else if (event.type === 'INVOKE') {
        logCommand(`${event.cmd}${event.args ? ' ' + JSON.stringify(event.args) : ''}`);
        run(
          withTransport((t) => t.invoke(event.cmd, event.args || {})),
          { logPrefix: event.cmd },
        );
      } else if (event.type === 'RESTORE_SESSION') {
        logCommand(`restore_session ${event.sessionName}`);
        run(
          withTransport((t) => t.invoke('restore_session', { session: event.sessionName })),
          {
            logPrefix: 'restore_session',
            // The session exists only once the rebuild has answered.
            onSuccess: () =>
              parent.send({ type: 'SESSION_SWITCH_REQUESTED', sessionName: event.sessionName }),
          },
        );
      } else if (event.type === 'FETCH_INITIAL_STATE') {
        logCommand(`get_initial_state cols=${event.cols} rows=${event.rows}`);
        run(
          // The adapter decodes the answer: wire-format drift rejects with a
          // ProtocolError, distinguishable from network/tmux failures.
          withTransport((t) =>
            t.invoke<ServerState>('get_initial_state', { cols: event.cols, rows: event.rows }),
          ),
          {
            onSuccess: (state) => parent.send({ type: 'TMUX_STATE_UPDATE', state }),
            logPrefix: 'get_initial_state',
          },
        );
      } else if (event.type === 'FETCH_SCROLLBACK_CELLS') {
        // Interrupt any in-flight fetch for this pane so its eventual
        // success doesn't fire onSuccess and clobber fresher data.
        const existing = scrollbackFibers.get(event.paneId);
        if (existing) runtime.runFork(Fiber.interrupt(existing));

        const program = withTransport((t) =>
          t.decodingInvoke('get_scrollback_cells', ScrollbackCells, {
            paneId: event.paneId,
            start: event.start,
            end: event.end,
          }),
        ).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              parent.send({
                type: 'COPY_MODE_CHUNK_LOADED',
                paneId: event.paneId,
                cells: result.cells,
                start: result.start,
                end: result.end,
                historySize: result.historySize,
                width: result.width,
              });
            }),
          ),
          // Clear the slot whether we succeed, fail, or get interrupted.
          Effect.ensuring(
            Effect.sync(() => {
              // Only clear if this fiber is still the registered one — a
              // newer FETCH might have already replaced it before this
              // finalizer ran.
              if (scrollbackFibers.get(event.paneId) === fiber) {
                scrollbackFibers.delete(event.paneId);
              }
            }),
          ),
          // Soft-fail: log the error, never crash the parent. A failed
          // scrollback fetch shouldn't surface as a UI-level TMUX_ERROR.
          Effect.catchAll((e) =>
            Effect.sync(() => {
              console.error(
                `[tmuxActor] get_scrollback_cells failed:`,
                e._tag,
                formatAdapterError(e),
              );
            }),
          ),
        );

        const fiber = runtime.runFork(program);
        scrollbackFibers.set(event.paneId, fiber);
      } else if (
        event.type === 'FETCH_TRACE_SETTINGS' ||
        event.type === 'SET_TRACE_ENABLED' ||
        event.type === 'SET_TRACE_LEVEL'
      ) {
        // Mutations re-read afterwards so the menu shows what is actually in
        // force — an enable can be refused by a DO_NOT_TRACK kill switch, and
        // an unknown level normalises to `shape` server-side.
        const write =
          event.type === 'SET_TRACE_ENABLED'
            ? withTransport((t) => t.invoke('set_trace_enabled', { enabled: event.enabled }))
            : event.type === 'SET_TRACE_LEVEL'
              ? withTransport((t) => t.invoke('set_trace_level', { level: event.level }))
              : null;
        const read = withTransport((t) => t.invoke<TraceSettings>('get_trace_settings', {}));
        run(write ? Effect.flatMap(write, () => read) : read, {
          onSuccess: (settings) => {
            if (!settings) return;
            // The backend is the authority for the tracer's own switch too, so
            // the client stops/starts shipping in step with the menu.
            tracer.setServerEnabled(!!settings.enabled);
            parent.send({ type: 'TRACE_SETTINGS_RECEIVED', settings });
          },
          logPrefix: 'trace settings',
          silentFail: true,
        });
      } else if (event.type === 'OPEN_TRACE_FILE') {
        run(
          withTransport((t) => t.invoke('open_trace_file', {})),
          { logPrefix: 'open_trace_file' },
        );
      } else if (event.type === 'FETCH_THEME_SETTINGS') {
        run(
          withTransport((t) => t.decodingInvoke('get_theme_settings', ThemeSettings, {})),
          {
            onSuccess: themeSettingsReceived,
            logPrefix: 'get_theme_settings',
            silentFail: true,
          },
        );
      } else if (event.type === 'FETCH_THEMES_LIST') {
        run(
          withTransport((t) =>
            t.invoke<Array<{ name: string; displayName: string }>>('get_themes_list', {}),
          ),
          {
            onSuccess: (themes) =>
              parent.send({ type: 'THEMES_LIST_RECEIVED', themes: themes || [] }),
            logPrefix: 'get_themes_list',
            silentFail: true,
          },
        );
      } else if (event.type === 'RECONNECT_NOW') {
        runtime.runFork(withTransport((t) => t.reconnectNow));
      } else if (event.type === 'SWITCH_SESSION') {
        run(
          withTransport((t) => t.switchSession(event.sessionName)),
          {
            logPrefix: `switch-session ${event.sessionName}`,
          },
        );
      } else if (event.type === 'CHECK_SESSION_SWITCH') {
        // A read, so it must be a query: run_tmux_command resolves null on
        // every transport, and matching on String(null) is how this check
        // sat dead on the web for a while.
        run(
          withTransport((t) => t.query('show-environment -g TMUXY_SWITCH_TO')),
          {
            onSuccess: (result) => {
              const str = String(result);
              const match = str.match(/TMUXY_SWITCH_TO=(.+)/);
              if (!match) return;
              const sessionName = match[1].trim();
              parent.send({ type: 'SESSION_SWITCH_REQUESTED', sessionName });
              // Clear the env var (fire-and-forget)
              run(
                withTransport((t) =>
                  t.invoke('run_tmux_command', {
                    command: toTmuxCommand(TmuxOp.ClearSwitchRequest()),
                  }),
                ),
                { silentFail: true, logPrefix: 'clear TMUXY_SWITCH_TO' },
              );
            },
            silentFail: true,
            logPrefix: 'check session switch',
          },
        );
      }
    });

    return () => {
      // Stop forwarding, drop pending scrollback fetches so they don't send
      // to a dead parent, and close the connection.
      runtime.runFork(Fiber.interrupt(session));
      for (const fiber of scrollbackFibers.values()) runtime.runFork(Fiber.interrupt(fiber));
      scrollbackFibers.clear();
      runtime.runSync(withTransport((t) => t.disconnect));
    };
  });
}
