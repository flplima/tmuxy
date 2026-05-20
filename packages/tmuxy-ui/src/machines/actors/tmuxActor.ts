import { fromCallback, type AnyActorRef } from 'xstate';
import { Cause, Effect, Exit } from 'effect';
import type { TmuxAdapter, ServerState, KeyBindings } from '../../tmux/types';
import {
  toEffectAdapter,
  type AdapterError,
  Schemas,
} from '../../tmux/effect';

export type TmuxActorEvent =
  | { type: 'SEND_COMMAND'; command: string }
  | { type: 'INVOKE'; cmd: string; args?: Record<string, unknown> }
  | { type: 'FETCH_INITIAL_STATE'; cols: number; rows: number }
  | { type: 'FETCH_SCROLLBACK_CELLS'; paneId: string; start: number; end: number }
  | { type: 'FETCH_THEME_SETTINGS' }
  | { type: 'FETCH_THEMES_LIST' }
  | { type: 'SWITCH_SESSION'; sessionName: string }
  | { type: 'CHECK_SESSION_SWITCH' };

export interface TmuxActorInput {
  parent: AnyActorRef;
}

/**
 * Convert a typed AdapterError into a human-readable string for logs and
 * the status-line display. The structured `tagged` field stays available
 * on the TMUX_ERROR event for consumers that want pattern matching.
 */
function adapterErrorToString(e: AdapterError): string {
  switch (e._tag) {
    case 'TmuxError':
      return `${e.command}: ${e.stderr}`;
    case 'TransportError':
      return e.context ? `${e.context}: ${String(e.cause)}` : String(e.cause);
    case 'ProtocolError':
      return `protocol error: ${e.reason}`;
    case 'Cancelled':
      return e.reason ? `cancelled: ${e.reason}` : 'cancelled';
  }
}

/**
 * Create a tmux actor with the given adapter.
 *
 * Internally wraps the Promise-based adapter with an Effect-based facade
 * (toEffectAdapter) so failures carry the AdapterError ADT instead of
 * arbitrary string messages. Errors tunnel back to the parent machine as
 * { type: 'TMUX_ERROR', error: <display string>, tagged: <AdapterError> }
 * — consumers can switch on `tagged._tag` for typed handling and fall back
 * to `error` for logging.
 */
export function createTmuxActor(adapter: TmuxAdapter) {
  return fromCallback<TmuxActorEvent, TmuxActorInput>(({ input, receive }) => {
    const { parent } = input;
    const eff = toEffectAdapter(adapter);

    const logInfo = (message: string) => parent.send({ type: 'LOG_APPEND', kind: 'info', message });
    const logCommand = (message: string) =>
      parent.send({ type: 'LOG_APPEND', kind: 'command', message });
    const logError = (message: string) =>
      parent.send({ type: 'LOG_APPEND', kind: 'error', message });

    /**
     * Run an Effect program, send typed errors to the parent, and invoke
     * onSuccess on the resolved value. logPrefix attaches a context label
     * to the LOG_APPEND error entry (e.g. command name) for debuggability.
     *
     * silentFail: skip tunneling the error to the parent (used for
     * fire-and-forget operations like FETCH_SCROLLBACK_CELLS where a
     * failed fetch shouldn't surface as a UI error).
     */
    const run = <T>(
      effect: Effect.Effect<T, AdapterError>,
      opts: {
        onSuccess?: (value: T) => void;
        logPrefix?: string;
        silentFail?: boolean;
      } = {},
    ) => {
      void Effect.runPromiseExit(effect).then((exit) => {
        if (Exit.isSuccess(exit)) {
          opts.onSuccess?.(exit.value);
          return;
        }
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag !== 'Some') return;
        const tagged = failure.value;
        const display = adapterErrorToString(tagged);
        if (opts.silentFail) {
          console.error(
            `[tmuxActor] ${opts.logPrefix ?? 'effect'} failed:`,
            tagged._tag,
            display,
          );
          return;
        }
        if (opts.logPrefix) logError(`${opts.logPrefix} -> ${display}`);
        parent.send({ type: 'TMUX_ERROR', error: display, tagged });
      });
    };

    logInfo('Connecting to tmux backend...');

    // Subscribe to adapter events (still callback-based — Phase E2 will
    // convert SSE to Effect Stream for backpressure + structured cancellation).
    const unsubscribeState = adapter.onStateChange((state: ServerState) => {
      parent.send({ type: 'TMUX_STATE_UPDATE', state });
    });

    const unsubscribeError = adapter.onError((error: string) => {
      logError(error);
      parent.send({ type: 'TMUX_ERROR', error });
    });

    const unsubscribeLog = adapter.onLog((kind, message) => {
      parent.send({ type: 'LOG_APPEND', kind, message });
    });

    const unsubscribeFatal = adapter.onFatal((message) => {
      logError(message);
      parent.send({ type: 'TMUX_FATAL', message });
    });

    const unsubscribeKeyBindings = adapter.onKeyBindings((keybindings: KeyBindings) => {
      parent.send({ type: 'KEYBINDINGS_RECEIVED', keybindings });
    });

    const unsubscribeConnectionInfo = adapter.onConnectionInfo(
      (connectionId: number, defaultShell: string) => {
        parent.send({ type: 'CONNECTION_INFO', connectionId, defaultShell });
      },
    );

    run(eff.connect(), {
      onSuccess: () => {
        logInfo('Connected to tmux backend');
        parent.send({ type: 'TMUX_CONNECTED' });
      },
      logPrefix: 'Connect failed',
    });

    receive((event) => {
      if (event.type === 'SEND_COMMAND') {
        logCommand(event.command);
        run(eff.invoke<void>('run_tmux_command', { command: event.command }), {
          logPrefix: event.command,
        });
      } else if (event.type === 'INVOKE') {
        logCommand(`${event.cmd}${event.args ? ' ' + JSON.stringify(event.args) : ''}`);
        run(eff.invoke(event.cmd, event.args || {}), { logPrefix: event.cmd });
      } else if (event.type === 'FETCH_INITIAL_STATE') {
        logCommand(`get_initial_state cols=${event.cols} rows=${event.rows}`);
        run(
          // Schema-decoded: any wire-format drift surfaces as ProtocolError,
          // distinguishable from network/tmux failures in TMUX_ERROR.tagged.
          eff.decodingInvoke('get_initial_state', Schemas.ServerState, {
            cols: event.cols,
            rows: event.rows,
          }),
          {
            onSuccess: (state) =>
              parent.send({ type: 'TMUX_STATE_UPDATE', state: state as ServerState }),
            logPrefix: 'get_initial_state',
          },
        );
      } else if (event.type === 'FETCH_SCROLLBACK_CELLS') {
        run(
          eff.invoke<{
            cells: import('../../tmux/types').PaneContent;
            historySize: number;
            start: number;
            end: number;
            width: number;
          }>('get_scrollback_cells', {
            paneId: event.paneId,
            start: event.start,
            end: event.end,
          }),
          {
            onSuccess: (result) => {
              parent.send({
                type: 'COPY_MODE_CHUNK_LOADED',
                paneId: event.paneId,
                cells: result.cells,
                start: result.start,
                end: result.end,
                historySize: result.historySize,
                width: result.width,
              });
            },
            logPrefix: 'get_scrollback_cells',
            silentFail: true,
          },
        );
      } else if (event.type === 'FETCH_THEME_SETTINGS') {
        run(
          eff.invoke<{ theme: string; mode: string }>('get_theme_settings', {}),
          {
            onSuccess: (result) => {
              parent.send({
                type: 'THEME_SETTINGS_RECEIVED',
                theme: result.theme || 'default',
                mode: (result.mode === 'light' ? 'light' : 'dark') as 'dark' | 'light',
              });
            },
            logPrefix: 'get_theme_settings',
            silentFail: true,
          },
        );
      } else if (event.type === 'FETCH_THEMES_LIST') {
        run(
          eff.invoke<Array<{ name: string; displayName: string }>>('get_themes_list', {}),
          {
            onSuccess: (themes) =>
              parent.send({ type: 'THEMES_LIST_RECEIVED', themes: themes || [] }),
            logPrefix: 'get_themes_list',
            silentFail: true,
          },
        );
      } else if (event.type === 'SWITCH_SESSION') {
        run(eff.switchSession(event.sessionName), {
          logPrefix: `switch-session ${event.sessionName}`,
        });
      } else if (event.type === 'CHECK_SESSION_SWITCH') {
        run(
          eff.invoke<string>('run_tmux_command', {
            command: 'show-environment -g TMUXY_SWITCH_TO',
          }),
          {
            onSuccess: (result) => {
              const str = String(result);
              const match = str.match(/TMUXY_SWITCH_TO=(.+)/);
              if (!match) return;
              const sessionName = match[1].trim();
              parent.send({ type: 'SESSION_SWITCH_REQUESTED', sessionName });
              // Clear the env var (fire-and-forget)
              run(
                eff.invoke('run_tmux_command', {
                  command: 'set-environment -g -u TMUXY_SWITCH_TO',
                }),
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
      unsubscribeState();
      unsubscribeError();
      unsubscribeLog();
      unsubscribeFatal();
      unsubscribeKeyBindings();
      unsubscribeConnectionInfo();
      adapter.disconnect();
    };
  });
}

/**
 * Helper to send command to tmux actor
 */
export function sendTmuxCommand(command: string): TmuxActorEvent {
  return { type: 'SEND_COMMAND', command };
}
