/**
 * The React contexts the app provider fills: the machine actor and the static
 * config flags. Kept apart from `AppContext.tsx` so that file exports only its
 * component, and from `appHooks.ts`, which reads them.
 */

import { createContext } from 'react';
import type { AppMachineActor } from './app/appMachine';

export interface AppConfig {
  /** When true, wheel events on panes with no scrollback bubble to the parent page */
  forwardScrollToParent?: boolean;
  /** When true, keyboard capture is gated by click-to-focus on the app container */
  requireFocus?: boolean;
  /** When true, running in demo mode — disables session/host click actions */
  isDemo?: boolean;
  /**
   * Run the desktop app's trackpad gesture actor (docs/DESKTOP.md) off the
   * desktop — for a story that drives it with the shell's own events.
   */
  desktopGestures?: boolean;
  /**
   * Take the phone layout (or not) whatever the window's media query says —
   * for a story, whose frame is not the viewport the query reads.
   */
  phoneLayout?: boolean;
}

export const AppConfigContext = createContext<AppConfig>({});

export const AppActorContext = createContext<AppMachineActor | null>(null);
