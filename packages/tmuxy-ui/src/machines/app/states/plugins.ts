/**
 * plugins state — the `on` slice for the installed plugins' menu actions.
 *
 * Owns context fields: plugins, pluginsRev.
 *
 * A new `@tmuxy-plugins-rev` on the state stream (raised by the model
 * update) has the inventory read again; a menu item sends PLUGIN_ACTION.
 * Action implementations live in ../actions/plugins.ts.
 *
 * All events here are global: pluginsState.on is spread into the machine's
 * root on:.
 */

export const pluginsState = {
  on: {
    PLUGINS_REV_CHANGED: { actions: 'plugins_revChanged' },
    PLUGINS_RECEIVED: { actions: 'plugins_received' },
    PLUGIN_ACTION: { actions: 'plugins_runAction' },
  },
} as const;
