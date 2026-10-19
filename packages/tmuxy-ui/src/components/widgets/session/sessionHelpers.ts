import type { ServerReachability, TmuxServer } from '../../../machines/types/domain';

export type Row =
  | {
      kind: 'session';
      name: string;
      windows: number;
      current: boolean;
      serverId: string | null;
    }
  | {
      kind: 'new-session';
      serverId: string | null;
    }
  | {
      kind: 'server';
      id: string;
      label: string;
      detail: string;
      current: boolean;
      reachable: ServerReachability;
      deletable: boolean;
    }
  | {
      kind: 'connect-server';
    };

/** Format unix seconds as a compact relative timestamp (e.g. `2m ago`, `3h ago`). */
export function formatLastUsed(lastUsed?: number | null): string | null {
  if (!lastUsed || lastUsed <= 0) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, nowSec - lastUsed);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Build the detail string for a server row in Step 1 (`Servers`). */
export function formatServerDetail(server: TmuxServer): string {
  if (server.kind === 'ssh' && server.ssh) {
    const target = `${server.ssh.user ? `${server.ssh.user}@` : ''}${server.ssh.host}`;
    const sock = server.socket || 'tmuxy';
    const lastUsed = formatLastUsed(server.last_used);
    return `ssh ${target} · ${sock}${lastUsed ? ` · ${lastUsed}` : ''}`;
  }
  const sock = `socket ${server.socket}`;
  if (typeof server.session_count === 'number') {
    const n = server.session_count;
    return `${sock} · ${n} session${n === 1 ? '' : 's'}`;
  }
  return sock;
}

/** Resolve the reach dot state for a server row in Step 1 (`Servers`). */
export function resolveServerReachability(
  server: TmuxServer,
  currentServerId: string | null,
): ServerReachability {
  if (
    server.reachable === 'online' ||
    server.reachable === 'offline' ||
    server.reachable === 'known'
  ) {
    return server.reachable;
  }
  if (server.id === currentServerId) return 'online';
  if (server.kind === 'local' && (server.id === 'localhost' || server.id === 'my-tmux')) {
    return 'online';
  }
  return 'known';
}

/** Live read-back line for Step 2 (`Connect to` + `tmux socket`). */
export function formatConnectReadback(dest: string, socket: string): string {
  const trimmedDest = dest.trim();
  const trimmedSock = socket.trim() || 'tmuxy';
  const sockFlag = trimmedSock.includes('/') ? '-S' : '-L';
  if (trimmedDest) {
    return `→ ssh ${trimmedDest}, then tmux ${sockFlag} ${trimmedSock}`;
  }
  return `→ tmux ${sockFlag} ${trimmedSock} on this machine`;
}
