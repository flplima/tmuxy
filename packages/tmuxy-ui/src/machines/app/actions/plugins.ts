/**
 * Action implementations for the plugins slice (../states/plugins.ts).
 */

import { sendTo } from 'xstate';
import { act, assignCtx } from '../actionTypes';

export const pluginsActions = {
  /** Remember the revision and read the inventory it names (none: no plugins). */
  plugins_revChanged: act(({ event, enqueue }) => {
    if (event.type !== 'PLUGINS_REV_CHANGED') return;
    enqueue.assign(
      event.rev === '' ? { pluginsRev: event.rev, plugins: [] } : { pluginsRev: event.rev },
    );
    if (event.rev !== '') enqueue(sendTo('tmux', { type: 'FETCH_PLUGINS' as const }));
  }),

  plugins_received: assignCtx(({ event }) => {
    if (event.type !== 'PLUGINS_RECEIVED') return {};
    return { plugins: event.plugins };
  }),

  /**
   * A menu item: the action on its pane, or the active one. The surface is
   * the manifest's, read by `tmuxy plugin action`, never the client's.
   */
  plugins_runAction: act(({ event, context, enqueue }) => {
    if (event.type !== 'PLUGIN_ACTION') return;
    const paneId = event.paneId ?? context.activePaneId;
    if (!paneId) return;
    enqueue(
      sendTo('tmux', {
        type: 'RUN_PLUGIN_ACTION' as const,
        plugin: event.plugin,
        action: event.action,
        paneId,
        selection: event.selection ?? null,
      }),
    );
  }),
};
