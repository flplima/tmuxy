/**
 * A new desktop window's splash page: whether this window has attached yet,
 * the sessions on this machine it can join, and attaching it to one of them
 * or to an ssh host (`tmuxy-tauri-app/src/windows/attach.rs`). The first
 * window, and every browser tab, is attached from the start.
 */

import { isTauri } from './platform';
import { desktopInvoke } from './desktop';

/** A session on this machine's tmuxy server, as the splash page lists it. */
export interface LocalSession {
  name: string;
  /** How many tabs it has. */
  windows: number;
  /** A client is looking at it now. */
  attached: boolean;
}

/** Where a splash page attaches its window. */
export type AttachChoice = { session: string } | { ssh: string };

/** Whether this window is attached, or still to show its splash page. */
export async function windowAttached(): Promise<boolean> {
  if (!isTauri()) return true;
  const { attached } = await desktopInvoke<{ attached: boolean }>('window_attachment');
  return attached;
}

/** The sessions on this machine, for the splash page to list. */
export function listLocalSessions(): Promise<LocalSession[]> {
  return desktopInvoke<LocalSession[]>('list_local_sessions');
}

/**
 * Attach this window as chosen. Rejects with the reason when it cannot (an
 * ssh host that is not one, a session that has gone), for the page to show.
 */
export function attachWindow(choice: AttachChoice): Promise<void> {
  return desktopInvoke<void>('attach_window', choice);
}

/** The words of a rejected attach: a command's `{ error, kind }`, or a thrown one. */
export function attachError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    if ('error' in e && typeof e.error === 'string') return e.error;
    if ('message' in e && typeof e.message === 'string') return e.message;
  }
  return 'could not attach';
}
