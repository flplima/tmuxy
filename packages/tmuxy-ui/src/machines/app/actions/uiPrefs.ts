/**
 * Action implementations for the uiPrefs state slice.
 *
 * Each action is prefixed `uiPrefs_` to avoid name collisions across states
 * when spread into setup({ actions }).
 *
 * Side effects (applyTheme, saveThemePref, applyFontSize,
 * saveFontSizePref) run imperatively inside enqueueActions before the
 * assigned context update; this matches the original appMachine behavior
 * where DOM/localStorage write happen synchronously with state mutation.
 */

import { appearancePrefs } from '../appearance';
import { assign, sendTo } from 'xstate';
import { act, assignCtx } from '../actionTypes';
import { invokeEvent } from '../../actors/tmuxActor';
import {
  applyTheme,
  applyThemeMode,
  applyCssVars,
  reloadThemeCss,
} from '../../../infra/themeManager';
import {
  applyFontSize,
  increaseFontSize,
  decreaseFontSize,
  DEFAULT_FONT_SIZE,
} from '../../../infra/fontSizeManager';
import { applyAppearance } from '../../../infra/appearanceManager';
import { DEFAULT_THEME, saveFontSizePref, saveThemePref } from '../../../infra/prefs';
import { DEFAULT_SIZE_POLICY, sameSizePolicy } from '../../../domain/gridFit';
import { PINNABLE } from '../../../domain/pins';
import type { PaneId } from '../../../domain/ids';
import {
  disablePush,
  enablePush,
  onNotificationFocus,
  readPushState,
  type PushState,
} from '../../../infra/pushNotifications';

export const uiPrefsActions = {
  uiPrefs_applyTheme: act(({ event, context, enqueue }) => {
    if (event.type !== 'SET_THEME') return;
    // tmuxy.conf pins it: the config's theme stays, whatever asked.
    if (context.pinnedOptions.includes(PINNABLE.theme)) return;
    applyTheme(event.name, context.themeMode);
    saveThemePref(event.name, context.themeMode);
    enqueue(assign({ themeName: event.name }));
    // The theme is the session's, on every transport: tmux holds it, and
    // every other client watching — a phone, the desktop app — is sent it
    // (THEME_REV_CHANGED). localStorage only paints the next load's first
    // frame before the backend has answered.
    enqueue(sendTo('tmux', invokeEvent({ cmd: 'set_theme', args: { name: event.name } })));
  }),

  uiPrefs_applyThemeMode: act(({ event, context, enqueue }) => {
    if (event.type !== 'SET_THEME_MODE') return;
    if (context.pinnedOptions.includes(PINNABLE.themeMode)) return;
    applyThemeMode(event.mode);
    saveThemePref(context.themeName, event.mode);
    enqueue(assign({ themeMode: event.mode }));
    // The session's, as the theme is (uiPrefs_applyTheme).
    enqueue(sendTo('tmux', invokeEvent({ cmd: 'set_theme_mode', args: { mode: event.mode } })));
  }),

  // This device's notifications on or off. The permission prompt has to come
  // from the tap itself (WebKit refuses it a moment later), and this action
  // runs inside the menu's click: enablePush asks before it awaits anything.
  uiPrefs_togglePush: act(({ context, self, enqueue }) => {
    const report = (state: PushState) => self.send({ type: 'PUSH_STATE', state });
    if (context.pushState === 'on') {
      enqueue(assign({ pushState: 'working' as PushState }));
      void disablePush().then(report);
    } else if (context.notifyAllowed && ['off', 'unknown'].includes(context.pushState)) {
      enqueue(assign({ pushState: 'working' as PushState }));
      void enablePush().then(report);
    }
  }),

  uiPrefs_pushState: act(({ event, enqueue }) => {
    if (event.type !== 'PUSH_STATE') return;
    enqueue(assign({ pushState: event.state }));
  }),

  // Some client picked a theme or a mode (tmux's `<theme>:<mode>` moved):
  // read the settings again, which applies them. The first value is the one
  // the connection's own read already answered.
  uiPrefs_themeRevChanged: act(({ event, context, enqueue }) => {
    if (event.type !== 'THEME_REV_CHANGED') return;
    enqueue(assign({ themeRev: event.rev }));
    if (context.themeRev !== '') {
      enqueue(sendTo('tmux', { type: 'FETCH_THEME_SETTINGS' as const }));
    }
  }),

  uiPrefs_acceptThemeSettings: act(({ context, event, enqueue, self }) => {
    if (event.type !== 'THEME_SETTINGS_RECEIVED') return;
    // The first settings are the backend answering: read where this device's
    // notifications stand, and let a tapped one bring its pane forward.
    if (context.pushState === 'unknown') {
      void readPushState().then((state) => self.send({ type: 'PUSH_STATE', state }));
      onNotificationFocus((paneId) => self.send({ type: 'SELECT_PANE', paneId: paneId as PaneId }));
    }
    const sizePolicy = event.appearance?.size ?? DEFAULT_SIZE_POLICY;
    if (!sameSizePolicy(sizePolicy, context.sizePolicy)) {
      enqueue(assign({ sizePolicy }));
      // The size this client asks for and the cell its grid is drawn in both
      // follow the policy.
      enqueue(sendTo('size', { type: 'RESEND_SIZE' as const }));
      enqueue.raise({ type: 'REFIT_GRID' as const });
    }
    // The appearance and the CSS variables have no client-side setting: the
    // config is their only source, so they always apply (and re-apply after
    // a source-file).
    if (event.appearance) applyAppearance(event.appearance);
    if (event.cssVars) applyCssVars(event.cssVars);
    enqueue(
      assign({
        ...appearancePrefs(event.appearance),
        processIcons: event.icons ?? {},
        pinnedOptions: event.pinned ?? [],
      }),
    );
    // The backend's theme is the one: tmux holds the session's, whichever
    // client picked it, and every client draws it (tmuxy.conf's when it pins
    // one). localStorage is only the cache the next load paints its first
    // frame with. The theme is applied HERE: a page that never ran main.tsx's
    // startup apply (a story) would otherwise have no stylesheet.
    applyTheme(event.theme, event.mode);
    saveThemePref(event.theme, event.mode);
    enqueue(assign({ themeName: event.theme, themeMode: event.mode }));
  }),

  // The blinking cursor is one setting for the machine, not one per client:
  // it lives in the tmux options the config seeds, so the flip goes to the
  // backend on every transport and comes back through THEME_SETTINGS_RECEIVED.
  uiPrefs_toggleCursorBlink: act(({ event, context, enqueue }) => {
    if (event.type !== 'TOGGLE_CURSOR_BLINK') return;
    if (context.pinnedOptions.includes(PINNABLE.cursorBlink)) return;
    const enabled = !context.cursorBlink;
    enqueue(assign({ cursorBlink: enabled }));
    enqueue(sendTo('tmux', invokeEvent({ cmd: 'set_cursor_blink', args: { enabled } })));
  }),

  uiPrefs_toggleSendAsk: act(({ event, context, enqueue }) => {
    if (event.type !== 'TOGGLE_SEND_ASK') return;
    if (context.pinnedOptions.includes(PINNABLE.sendAsk)) return;
    const enabled = !context.sendAsk;
    enqueue(assign({ sendAsk: enabled }));
    enqueue(sendTo('tmux', invokeEvent({ cmd: 'set_send_ask', args: { enabled } })));
  }),

  // The desktop app answers with fresh theme settings, which repaint the
  // surfaces (applyAppearance) as it puts every window's blur on or off.
  uiPrefs_toggleTransparency: act(({ event, context, enqueue }) => {
    if (event.type !== 'TOGGLE_TRANSPARENCY') return;
    if (context.pinnedOptions.includes(PINNABLE.transparency)) return;
    const enabled = !context.transparency;
    enqueue(assign({ transparency: enabled }));
    enqueue(sendTo('tmux', invokeEvent({ cmd: 'set_transparency', args: { enabled } })));
  }),

  // The list is also how a theme that went away is noticed: a plugin's theme
  // goes with its plugin, a user's with its file. The page falls back to the
  // default rather than keeping a stylesheet nothing serves.
  uiPrefs_setAvailableThemes: act(({ event, context, enqueue }) => {
    if (event.type !== 'THEMES_LIST_RECEIVED') return;
    enqueue(assign({ availableThemes: event.themes }));
    const gone = event.themes.length > 0 && !event.themes.some((t) => t.name === context.themeName);
    if (gone) {
      applyTheme('default', context.themeMode);
      saveThemePref(DEFAULT_THEME.theme, context.themeMode);
      enqueue(assign({ themeName: 'default' }));
    }
  }),

  // A stylesheet under the config dir was saved: fetch the CSS again, and the
  // list, since the save may have been a theme added or removed.
  uiPrefs_reloadCss: act(({ enqueue }) => {
    reloadThemeCss();
    enqueue(sendTo('tmux', { type: 'FETCH_THEMES_LIST' as const }));
  }),

  // --- Local action tracing (docs/TRACING.md) -----------------------------
  // Each mutation asks the backend and then re-reads it, rather than assuming
  // the request took: a kill switch can refuse an enable, and the level is
  // normalised server-side, so the menu must render the backend's answer.

  uiPrefs_fetchTraceSettings: act(({ enqueue }) => {
    enqueue(sendTo('tmux', { type: 'FETCH_TRACE_SETTINGS' as const }));
  }),

  uiPrefs_acceptTraceSettings: assignCtx(({ event }) => {
    if (event.type !== 'TRACE_SETTINGS_RECEIVED') return {};
    return { traceSettings: event.settings };
  }),

  uiPrefs_setTraceEnabled: act(({ event, enqueue }) => {
    if (event.type !== 'SET_TRACE_ENABLED') return;
    enqueue(sendTo('tmux', { type: 'SET_TRACE_ENABLED' as const, enabled: event.enabled }));
  }),

  uiPrefs_setTraceLevel: act(({ event, enqueue }) => {
    if (event.type !== 'SET_TRACE_LEVEL') return;
    enqueue(sendTo('tmux', { type: 'SET_TRACE_LEVEL' as const, level: event.level }));
  }),

  uiPrefs_openTraceFile: act(({ enqueue }) => {
    enqueue(sendTo('tmux', { type: 'OPEN_TRACE_FILE' as const }));
  }),

  uiPrefs_increaseFontSize: act(({ context, enqueue }) => {
    const newSize = increaseFontSize(context.baseFontSize);
    applyFontSize(newSize);
    saveFontSizePref(newSize);
    enqueue(assign({ baseFontSize: newSize }));
    enqueue(sendTo('size', { type: 'REMEASURE' as const }));
  }),

  uiPrefs_decreaseFontSize: act(({ context, enqueue }) => {
    const newSize = decreaseFontSize(context.baseFontSize);
    applyFontSize(newSize);
    saveFontSizePref(newSize);
    enqueue(assign({ baseFontSize: newSize }));
    enqueue(sendTo('size', { type: 'REMEASURE' as const }));
  }),

  uiPrefs_resetFontSize: act(({ enqueue }) => {
    applyFontSize(DEFAULT_FONT_SIZE);
    saveFontSizePref(DEFAULT_FONT_SIZE);
    enqueue(assign({ baseFontSize: DEFAULT_FONT_SIZE }));
    enqueue(sendTo('size', { type: 'REMEASURE' as const }));
  }),
};
