/**
 * A pane's listening ports as its tree row shows them, and the address a
 * click opens. The host finds the ports (`tmuxy-core/src/ports.rs`,
 * published as `panePorts` by the sessions poll).
 */

import type { PanePorts } from '../domain/servers';
import type { PaneId } from '../domain/ids';

/** Each pane's ports, by pane. */
export function portsByPane(list: readonly PanePorts[]): Map<PaneId, readonly number[]> {
  return new Map(list.map((entry) => [entry.paneId as PaneId, entry.ports]));
}

/**
 * The page a port serves, on the machine the panes run on. In a browser that
 * is the host this page came from: on the same machine it is `localhost`,
 * and from elsewhere its name or address, which reaches the port only when
 * the program listens beyond loopback. The desktop app runs beside its
 * panes, so there it is `localhost`. `location.hostname` already brackets an
 * IPv6 address; a bare one is bracketed here.
 */
export function portUrl(port: number, pageHost: string | null): string {
  const bare = pageHost?.includes(':') && !pageHost.startsWith('[');
  const host = !pageHost ? 'localhost' : bare ? `[${pageHost}]` : pageHost;
  return `http://${host}:${port}/`;
}
