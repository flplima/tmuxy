/**
 * plugins state — the installed plugins' menu actions. A new
 * `@tmuxy-plugins-rev` on the state stream has the inventory read again.
 */

export const pluginsState = {
  on: {
    PLUGINS_REV_CHANGED: { actions: 'plugins_revChanged' },
    PLUGINS_RECEIVED: { actions: 'plugins_received' },
    PLUGIN_ACTION: { actions: 'plugins_runAction' },
    PLUGIN_OPEN_LINK: { actions: 'plugins_openLink' },
    PLUGIN_OPEN_TEXT: { actions: 'plugins_openLink' },
  },
} as const;
