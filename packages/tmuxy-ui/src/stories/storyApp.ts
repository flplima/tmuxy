import type { AppHandle } from '../machines/testView';
import type { AppMachineContext } from '../machines/types/context';

/** The mounted app (`window.app`); throws before it mounts. */
export function storyApp(): AppHandle {
  if (!window.app) throw new Error('window.app is not available: is the app mounted?');
  return window.app;
}

/** The machine's context now, typed: a renamed field breaks the story at compile time. */
export const appContext = (): AppMachineContext => storyApp().getSnapshot().context;
