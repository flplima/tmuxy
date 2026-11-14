import { fromCallback, type AnyActorRef } from 'xstate';
import { Effect, Exit, Fiber, Stream } from 'effect';
import type { ThemeSettings } from '../../domain/wire';
import { formatAdapterError, type AdapterError } from '../../infra/transport/AdapterError';
import { tracer } from '../../infra/tracer';
import { failureText } from './failureText';
import type { PaneId } from '../../domain/ids';
import { toTmuxCommand, TmuxOp } from '../../domain/commands';
import type { AppRuntime } from '../../infra/runtime';
import { TmuxTransport, type TmuxTransportService } from '../../infra/transport/TmuxTransport';
import { TransportEvent } from '../../infra/transport/events';
import { parseThemeMode, type TraceLevel } from '../../domain/wireSettings';
import type { PlainCall } from '../../domain/backendCalls';
import { parseInventory, READ_PLUGINS_COMMAND } from '../../domain/plugins';
import { openExternalUrl } from '../../infra/openUrl';

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
  /** A backend command whose answer nothing reads. */
  | ({ type: 'INVOKE' } & PlainCall)
  | { type: 'FETCH_INITIAL_STATE'; cols: number; rows: number }
  /** The grid this client shows, for the backend to size the session to. */
  | { type: 'SET_CLIENT_SIZE'; cols: number; rows: number }
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
  /** Read the plugin inventory (`@tmuxy-plugins`) and send PLUGINS_RECEIVED. */
  | { type: 'FETCH_PLUGINS' }
  /**
   * Ask the server whether a plugin's link handler takes a click; launch its
   * action, else open `fallbackUrl` (if any) in the browser.
   */
  | ({
      type: 'OPEN_PLUGIN_LINK';
      paneId: PaneId;
      fallbackUrl: string | null;
    } & Extract<PlainCall, { readonly cmd: 'open_link' | 'open_text' }>)
  /** Run a plugin's action, preparing a token for the selection first. */
  | {
      type: 'RUN_PLUGIN_ACTION';
      plugin: string;
      action: string;
      paneId: PaneId;
      selection: string | null;
    };

/** The tmux actor's event for a plain command, typed where `sendTo` is not. */
export const invokeEvent = (call: PlainCall): TmuxActorEvent => ({ type: 'INVOKE', ...call });

export interface TmuxActorInput {
  parent: AnyActorRef;
}

/**
 * The tmux actor over the app runtime's transport: forwards the transport's
 * events to the parent and runs the parent's requests as Effects. A failed
 * request reaches the parent as TMUX_ERROR with the AdapterError's display
 * string, unless it is `silentFail`.
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
      /**
       * No error on screen: a failure here is no UI error (e.g. a settings
       * read). It still goes to the console and the connection log, so a
       * run that went wrong says why.
       */
      silentFail?: boolean;
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
          const display = failureText(exit.cause);
          if (display === null) return;
          if (opts.silentFail) {
            console.error(`[tmuxActor] ${opts.logPrefix ?? 'effect'} failed:`, display);
            logError(`${opts.logPrefix ?? 'effect'} -> ${display}`);
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

    /** An op straight on the transport, logged as the command it is. */
    const runOp = (op: TmuxOp): void => {
      const command = toTmuxCommand(op);
      logCommand(command);
      run(
        withTransport((t) => t.run(op)),
        { logPrefix: command },
      );
    };

    /**
     * The in-flight scrollback fetch of each pane. A new fetch interrupts the
     * last one, so answers racing in out of order never put a stale chunk
     * over a fresher one: the request itself still completes, but its
     * interrupted fiber reports nothing to the parent.
     */
    const scrollbackFibers = new Map<PaneId, Fiber.RuntimeFiber<unknown>>();

    const themeSettingsReceived = (settings: ThemeSettings) =>
      parent.send({
        type: 'THEME_SETTINGS_RECEIVED',
        theme: settings.theme || 'default',
        mode: parseThemeMode(settings.mode),
        appearance: settings.appearance,
        cssVars: settings.cssVars,
        icons: settings.icons,
        pinned: settings.pinned,
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
      CssChanged: () => parent.send({ type: 'CSS_CHANGED' }),
      ConnectionInfo: ({ defaultShell, hostname }) =>
        parent.send({ type: 'CONNECTION_INFO', defaultShell, hostname }),
      // OSC 52 clipboard requests from terminal applications.
      Clipboard: ({ paneId, text }) => parent.send({ type: 'TMUX_CLIPBOARD', paneId, text }),
      // `display-message` output: a notice in the snackbar, not an error.
      Message: ({ text }) => parent.send({ type: 'NOTIFY', text, kind: 'info' }),
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
        runOp(event.op);
      } else if (event.type === 'INVOKE') {
        logCommand(`${event.cmd} ${JSON.stringify(event.args)}`);
        run(
          withTransport((t) => t.send(event)),
          { logPrefix: event.cmd },
        );
      } else if (event.type === 'SET_CLIENT_SIZE') {
        logCommand(`set_client_size cols=${event.cols} rows=${event.rows}`);
        run(
          withTransport((t) => t.setClientSize({ cols: event.cols, rows: event.rows })),
          { logPrefix: 'set_client_size' },
        );
      } else if (event.type === 'RESTORE_SESSION') {
        logCommand(`restore_session ${event.sessionName}`);
        run(
          withTransport((t) => t.call('restore_session', { session: event.sessionName })),
          {
            logPrefix: 'restore_session',
            // The session exists only once the rebuild has answered.
            onSuccess: () =>
              parent.send({ type: 'SWITCH_SESSION', sessionName: event.sessionName }),
          },
        );
      } else if (event.type === 'FETCH_INITIAL_STATE') {
        logCommand(`get_initial_state cols=${event.cols} rows=${event.rows}`);
        run(
          // The transport decodes the answer: wire-format drift rejects with a
          // ProtocolError, distinguishable from network/tmux failures.
          withTransport((t) => t.fetchState({ cols: event.cols, rows: event.rows })),
          {
            onSuccess: (state) => parent.send({ type: 'TMUX_STATE_UPDATE', state }),
            logPrefix: 'get_initial_state',
          },
        );
      } else if (event.type === 'FETCH_SCROLLBACK_CELLS') {
        const existing = scrollbackFibers.get(event.paneId);
        if (existing) runtime.runFork(Fiber.interrupt(existing));

        const program = withTransport((t) =>
          t.call('get_scrollback_cells', {
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
          Effect.ensuring(
            Effect.sync(() => {
              // A newer fetch may already have replaced this fiber.
              if (scrollbackFibers.get(event.paneId) === fiber) {
                scrollbackFibers.delete(event.paneId);
              }
            }),
          ),
          // Soft-fail: log the error, never crash the parent. A failed
          // scrollback fetch shouldn't surface as a UI-level TMUX_ERROR; the
          // copy-mode record is told so it stops waiting for the chunk.
          Effect.catchAll((e) =>
            Effect.sync(() => {
              console.error(
                `[tmuxActor] get_scrollback_cells failed:`,
                e._tag,
                formatAdapterError(e),
              );
              parent.send({ type: 'COPY_MODE_CHUNK_FAILED', paneId: event.paneId });
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
            ? withTransport((t) =>
                Effect.asVoid(t.call('set_trace_enabled', { enabled: event.enabled })),
              )
            : event.type === 'SET_TRACE_LEVEL'
              ? withTransport((t) =>
                  Effect.asVoid(t.call('set_trace_level', { level: event.level })),
                )
              : null;
        const read = withTransport((t) => t.call('get_trace_settings', {}));
        run(write ? Effect.flatMap(write, () => read) : read, {
          onSuccess: (settings) => {
            // The backend is the authority for the tracer's own switch too, so
            // the client stops/starts shipping in step with the menu.
            tracer.setServerEnabled(!!settings.enabled);
            parent.send({ type: 'TRACE_SETTINGS_RECEIVED', settings });
          },
          logPrefix: 'trace settings',
          silentFail: true,
        });
      } else if (event.type === 'FETCH_PLUGINS') {
        // A transport that answers no queries (a recorded fixture) has no
        // plugins: the menus stay as they are.
        run(
          withTransport((t) => t.query(READ_PLUGINS_COMMAND)),
          {
            onSuccess: (raw) =>
              parent.send({ type: 'PLUGINS_RECEIVED', plugins: parseInventory(raw) }),
            logPrefix: 'plugins',
            silentFail: true,
          },
        );
      } else if (event.type === 'OPEN_PLUGIN_LINK') {
        const fallback = () => {
          if (event.fallbackUrl) openExternalUrl(event.fallbackUrl);
        };
        runtime.runFork(
          Effect.match(
            withTransport((t) =>
              event.cmd === 'open_link'
                ? t.call('open_link', event.args)
                : t.call('open_text', event.args),
            ),
            {
              // The link still opens, as the fallback; the log says why it was one.
              onFailure: (e) => {
                logError(`${event.cmd} -> ${formatAdapterError(e)}`);
                fallback();
              },
              onSuccess: (prepared) => {
                if (!prepared) return fallback();
                runOp(
                  TmuxOp.PluginAction({
                    plugin: prepared.plugin,
                    action: prepared.action,
                    paneId: event.paneId,
                    token: prepared.token,
                  }),
                );
              },
            },
          ),
        );
      } else if (event.type === 'RUN_PLUGIN_ACTION') {
        const launch = (token: string | null) =>
          runOp(
            TmuxOp.PluginAction({
              plugin: event.plugin,
              action: event.action,
              paneId: event.paneId,
              token,
            }),
          );
        if (event.selection === null) {
          launch(null);
        } else {
          // The selected text goes to the server, which writes it into the
          // invocation token; only the token's id rides the command.
          run(
            withTransport((t) =>
              t.call('prepare_plugin_action', {
                plugin: event.plugin,
                action: event.action,
                paneId: event.paneId,
                selection: event.selection,
              }),
            ),
            {
              onSuccess: (prepared) => launch(prepared.token),
              logPrefix: 'prepare_plugin_action',
            },
          );
        }
      } else if (event.type === 'OPEN_TRACE_FILE') {
        run(
          withTransport((t) => t.call('open_trace_file', {})),
          { logPrefix: 'open_trace_file' },
        );
      } else if (event.type === 'FETCH_THEME_SETTINGS') {
        run(
          withTransport((t) => t.call('get_theme_settings', {})),
          {
            onSuccess: themeSettingsReceived,
            logPrefix: 'get_theme_settings',
            silentFail: true,
          },
        );
      } else if (event.type === 'FETCH_THEMES_LIST') {
        run(
          withTransport((t) => t.call('get_themes_list', {})),
          {
            onSuccess: (themes) => parent.send({ type: 'THEMES_LIST_RECEIVED', themes }),
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
            // A new stream starts with no state; the desktop's one client
            // is reported by its monitor wherever it lands.
            onSuccess: (newStream) => {
              if (newStream) parent.send({ type: 'TMUX_SESSION_SWITCHED' });
            },
            logPrefix: `switch-session ${event.sessionName}`,
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
