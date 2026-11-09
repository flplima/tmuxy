/**
 * A new desktop window's splash page: whether this window has attached yet,
 * the sessions on this machine it can join, and attaching it to one of them,
 * to a new one, or to a host over ssh (`tmuxy-tauri-app/src/windows/attach.rs`
 * and `ssh_link.rs`). The first window, and every browser tab, is attached
 * from the start.
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

/**
 * The ssh form: only the host is required. Left empty, the rest is what ssh
 * would do on its own (the user's config, agent and keys).
 */
export interface SshForm {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  certificateFile?: string;
  /** The account's password, or the key's passphrase: whichever ssh asks for. */
  password?: string;
  /** The page showed the host's fingerprint and the user trusted it. */
  trustNewHost?: boolean;
}

/**
 * Where a splash page attaches its window: a session to join, a new session
 * (a name, or `''` for the next number), or a host over ssh.
 */
export type AttachChoice = { session: string } | { newSession: string } | { ssh: SshForm };

/** What an attach came to: attached, or a host whose key is to be confirmed. */
export type AttachOutcome = { attached: true } | { unknownHost: { fingerprint: string | null } };

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
 * ssh host that is not one, a refused login, a session that has gone), for
 * the page to show.
 */
export function attachWindow(choice: AttachChoice): Promise<AttachOutcome> {
  return desktopInvoke<AttachOutcome>('attach_window', choice);
}

/** The hosts the user's `~/.ssh/config` names, for the host field to offer. */
export function listSshHosts(): Promise<string[]> {
  return desktopInvoke<string[]>('list_ssh_hosts');
}

/** A native file chooser in `~/.ssh`: the path picked, or null. */
export function pickSshFile(): Promise<string | null> {
  return desktopInvoke<string | null>('pick_ssh_file');
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
