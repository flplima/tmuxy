/**
 * The tmux actor's plugin events: a click on a link a plugin may handle, and
 * a plugin's action run with the selection behind a token. Kept apart from
 * `tmuxActor.ts`, which hands in its own runners.
 */

import { Effect } from 'effect';
import type { PaneId } from '../../domain/ids';
import { TmuxOp } from '../../domain/commands';
import type { PlainCall } from '../../domain/backendCalls';
import type { AppRuntime } from '../../infra/runtime';
import { openExternalUrl } from '../../infra/openUrl';
import { formatAdapterError, type AdapterError } from '../../infra/transport/AdapterError';
import type { TmuxTransport } from '../../infra/transport/TmuxTransport';
import { withTransport } from './withTransport';

export type PluginEvent =
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

/** What the handlers need of the tmux actor. */
export interface PluginRunners {
  runtime: AppRuntime;
  run: <T>(
    effect: Effect.Effect<T, AdapterError, TmuxTransport>,
    opts: { onSuccess?: (value: T) => void; logPrefix?: string },
  ) => void;
  runOp: (op: TmuxOp) => void;
  logError: (message: string) => void;
}

/**
 * Ask the server whether a plugin's link handler takes the click; launch its
 * action, else open the fallback URL (if any) in the browser.
 */
export function openPluginLink(
  event: Extract<PluginEvent, { type: 'OPEN_PLUGIN_LINK' }>,
  r: PluginRunners,
): void {
  const fallback = () => {
    if (event.fallbackUrl) openExternalUrl(event.fallbackUrl);
  };
  r.runtime.runFork(
    Effect.match(
      withTransport((t) =>
        event.cmd === 'open_link'
          ? t.call('open_link', event.args)
          : t.call('open_text', event.args),
      ),
      {
        // The link still opens, as the fallback; the log says why it was one.
        onFailure: (e) => {
          r.logError(`${event.cmd} -> ${formatAdapterError(e)}`);
          fallback();
        },
        onSuccess: (prepared) => {
          if (!prepared) return fallback();
          r.runOp(
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
}

/** Run a plugin's action, preparing a token for the selection first. */
export function runPluginAction(
  event: Extract<PluginEvent, { type: 'RUN_PLUGIN_ACTION' }>,
  r: PluginRunners,
): void {
  const launch = (token: string | null) =>
    r.runOp(
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
    r.run(
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
}
