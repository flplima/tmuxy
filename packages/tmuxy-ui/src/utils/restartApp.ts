/**
 * Debug ▸ Restart App: relaunch the desktop process in place (tmux keeps every
 * session and the new process reattaches on start); in a browser the nearest
 * thing is a full reload.
 */

import { isTauri } from './platform';
import { failing } from './logFailure';

export function restartApp(): void {
  if (isTauri()) {
    void import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke('restart_app').catch(failing('restart_app')),
    );
    return;
  }
  window.location.reload();
}
