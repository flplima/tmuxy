/**
 * TmuxySession — the `session` widget: switch, rename, kill or detach the
 * session, and attach to another tmux server.
 *
 * Rendered as a tmuxy WIDGET, like the tree: a real pane runs
 * `tmuxy widget session` in a float, and this draws in place of its terminal.
 * It replaces the `tmuxy session switch --float` shell prompt, which asked for
 * a number with `read -rp` and could only switch.
 *
 * Two lists, because they answer different questions:
 *  - SESSIONS on the server this client is attached to. Switching is a tmux
 *    `switch-client`, so it is instant and available on web and desktop alike.
 *  - SERVERS: other tmux sockets, on this machine or reached over SSH. The
 *    backend retargets the live monitor (`connect_server`), so nothing
 *    relaunches. Desktop only — `list_servers` is a Tauri command, and a web
 *    client always uses the socket it was launched against, so on web this
 *    list is simply empty and the section does not draw.
 *
 * Keys are handled here rather than through `WidgetDefinition.onKeyDown`
 * because this widget owns a selection cursor, and that hook is stateless.
 * SidebarTree does the same: a capture-phase listener that runs before the
 * keyboard actor, so j/k never reach tmux.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  useAppState,
  selectSessions,
} from '../../../machines/AppContext';
import { InlineRename } from '../../InlineRename';

/** A row in the switcher: a session on this server, or another server. */
type Row =
  | { kind: 'session'; name: string; windows: number; current: boolean }
  | { kind: 'server'; id: string; label: string; detail: string; current: boolean };

export const TmuxySession = memo(function TmuxySession() {
  const send = useAppSend();
  const sessions = useAppSelectorShallow(selectSessions);
  const servers = useAppSelectorShallow((ctx) => ctx.servers);
  const currentServerId = useAppSelector((ctx) => ctx.currentServerId);
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  // Hosted by the detached overlay rather than by a float, which changes what
  // activating a row means — see `activate`.
  const detached = useAppState('detached');

  const [cursor, setCursor] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The connect form. One destination field, one socket field — see the
  // component docstring for why there is nothing else to fill in.
  const [connecting, setConnecting] = useState(false);
  const [dest, setDest] = useState('');
  const [socket, setSocket] = useState('');

  const sessionRows = useMemo<Row[]>(() => {
    // Before the poll has answered (or on a sandbox that enumerates nothing)
    // the attached session is still worth listing — it is the one we know.
    const names = sessions.length > 0 ? sessions.map((s) => s.sessionName) : [sessionName];
    return names.map((name) => ({
      kind: 'session' as const,
      name,
      windows: sessions.find((s) => s.sessionName === name)?.windows.length ?? 0,
      current: name === sessionName,
    }));
  }, [sessions, sessionName]);

  const serverRows = useMemo<Row[]>(
    () =>
      servers.map((server) => ({
        kind: 'server' as const,
        id: server.id,
        label: server.label,
        // What actually distinguishes one server from another at a glance.
        detail:
          server.kind === 'ssh' && server.ssh
            ? `ssh ${server.ssh.user ? `${server.ssh.user}@` : ''}${server.ssh.host}`
            : server.socket,
        current: server.id === currentServerId,
      })),
    [servers, currentServerId],
  );

  const rows = useMemo(() => [...sessionRows, ...serverRows], [sessionRows, serverRows]);
  const selected = rows[Math.min(cursor, rows.length - 1)];

  /** Close the float this widget runs in — every verb is a one-shot. */
  const close = useCallback(() => send({ type: 'CLOSE_TOP_FLOAT' }), [send]);

  const activate = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === 'session') {
        if (!row.current) send({ type: 'SWITCH_SESSION', sessionName: row.name });
      } else if (!row.current || detached) {
        // Detached, reconnecting to the server you were already on IS the way
        // back in. Without this exception the "you are already there" guard
        // leaves the overlay's only listed server inert and the user stuck.
        send({ type: 'CONNECT_SERVER', serverId: row.id });
      }
      close();
    },
    [send, close, detached],
  );

  const killSelected = useCallback(
    (row: Row | undefined) => {
      if (row?.kind !== 'session') return;
      // Killing the session you are in would take the client down with it;
      // tmux would pick another, but the switcher is the wrong place to learn
      // that. Switch first, then kill.
      if (row.current) {
        setError('Switch to another session before killing this one.');
        return;
      }
      send({ type: 'SEND_TMUX_COMMAND', command: `kill-session -t ${JSON.stringify(row.name)}` });
      setError(null);
    },
    [send],
  );

  const detach = useCallback(() => {
    // Close the float FIRST: closing it is a tmux `kill-pane`, and once the
    // client is gone that command never lands — leaving the float alive behind
    // the overlay, with a second copy of this widget inside it.
    close();
    send({ type: 'DETACH_CLIENT' });
  }, [send, close]);

  // Capture-phase so the keys never reach the pane behind the float.
  /**
   * Adding a server is desktop-only: `list_servers` is a Tauri command, so a
   * web client never has one to add to. A desktop list always holds at least
   * localhost, which makes a non-empty list the signal.
   */
  const canConnect = servers.length > 0;

  const openConnect = useCallback(() => {
    if (canConnect) setConnecting(true);
  }, [canConnect]);

  const submitConnect = useCallback(() => {
    send({ type: 'ADD_SERVER', dest: dest.trim(), socket: socket.trim() || undefined });
    setConnecting(false);
    setDest('');
    setSocket('');
    // Saved, not attached: the poll lists it within a few seconds and Enter on
    // the row attaches. Chaining the two would need the new id back, and the
    // invoke path is fire-and-forget.
    setError('Saved. It will appear under Servers in a moment.');
  }, [send, dest, socket]);

  const stateRef = useRef({
    rows,
    cursor,
    activate,
    killSelected,
    detach,
    close,
    renaming,
    connecting,
    openConnect,
  });
  stateRef.current = {
    rows,
    cursor,
    activate,
    killSelected,
    detach,
    close,
    renaming,
    connecting,
    openConnect,
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const s = stateRef.current;
      // While a field is open every key belongs to it.
      if (s.renaming || s.connecting) return;
      const claim = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      const move = (delta: number) => {
        setCursor((c) => Math.max(0, Math.min(s.rows.length - 1, c + delta)));
      };
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          claim();
          move(1);
          return;
        case 'k':
        case 'ArrowUp':
          claim();
          move(-1);
          return;
        case 'Enter':
          claim();
          s.activate(s.rows[s.cursor]);
          return;
        case 'r':
          claim();
          if (s.rows[s.cursor]?.kind === 'session') setRenaming(true);
          return;
        case 'x':
          claim();
          s.killSelected(s.rows[s.cursor]);
          return;
        case 'd':
          claim();
          s.detach();
          return;
        case 'c':
          claim();
          s.openConnect();
          return;
        case 'Escape':
        case 'q':
          claim();
          s.close();
          return;
        default:
          // The widget owns the keyboard while it is up; anything else would
          // otherwise be typed into the pane the float covers.
          if (!e.ctrlKey && !e.altKey && !e.metaKey) e.stopImmediatePropagation();
          return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const commitRename = useCallback(
    (name: string) => {
      setRenaming(false);
      if (selected?.kind !== 'session') return;
      send({
        type: 'SEND_TMUX_COMMAND',
        command: `rename-session -t ${JSON.stringify(selected.name)} -- ${JSON.stringify(name)}`,
      });
    },
    [send, selected],
  );

  return (
    <div className="widget-session" data-testid="session-switcher">
      <div className="widget-session-heading">Sessions</div>
      <div className="widget-session-list">
        {sessionRows.map((row, i) => {
          const isSelected = rows[cursor] === row;
          return (
            <div
              key={`s:${row.kind === 'session' ? row.name : ''}`}
              role="option"
              aria-selected={isSelected}
              className={`widget-session-row${isSelected ? ' is-selected' : ''}${
                row.current ? ' is-current' : ''
              }`}
              data-testid={`session-row-${row.kind === 'session' ? row.name : ''}`}
              onClick={() => {
                setCursor(i);
                activate(row);
              }}
            >
              {renaming && isSelected && row.kind === 'session' ? (
                <InlineRename
                  value={row.name}
                  ariaLabel={`Rename session ${row.name}`}
                  onCommit={commitRename}
                  onCancel={() => setRenaming(false)}
                />
              ) : (
                <>
                  <span className="widget-session-name">{row.kind === 'session' && row.name}</span>
                  <span className="widget-session-meta">
                    {row.kind === 'session' && row.windows > 0
                      ? `${row.windows} window${row.windows === 1 ? '' : 's'}`
                      : ''}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>

      {serverRows.length > 0 && (
        <>
          <div className="widget-session-heading">Servers</div>
          <div className="widget-session-list">
            {serverRows.map((row, i) => {
              const isSelected = rows[cursor] === row;
              return (
                <div
                  key={`v:${row.kind === 'server' ? row.id : ''}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`widget-session-row${isSelected ? ' is-selected' : ''}${
                    row.current ? ' is-current' : ''
                  }`}
                  data-testid={`server-row-${row.kind === 'server' ? row.id : ''}`}
                  onClick={() => {
                    setCursor(sessionRows.length + i);
                    activate(row);
                  }}
                >
                  <span className="widget-session-name">{row.kind === 'server' && row.label}</span>
                  <span className="widget-session-meta">{row.kind === 'server' && row.detail}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {connecting && (
        <form
          className="widget-session-form"
          data-testid="session-connect-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitConnect();
          }}
          onKeyDown={(e) => {
            // The fields own every key, including the app's own bindings.
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              setConnecting(false);
            }
          }}
        >
          <div className="widget-session-field">
            <label htmlFor="session-connect-dest">Connect to</label>
            <input
              id="session-connect-dest"
              autoFocus
              value={dest}
              spellCheck={false}
              autoComplete="off"
              placeholder="user@host  ·  blank for this machine"
              onChange={(e) => setDest(e.target.value)}
            />
          </div>
          <div className="widget-session-field">
            <label htmlFor="session-connect-socket">tmux socket</label>
            <input
              id="session-connect-socket"
              value={socket}
              spellCheck={false}
              autoComplete="off"
              placeholder="tmuxy"
              onChange={(e) => setSocket(e.target.value)}
            />
          </div>
          <p className="widget-session-hint">
            Keys, ports and jump hosts come from your ~/.ssh/config — tmuxy runs your own ssh.
          </p>
        </form>
      )}

      {error && <div className="widget-session-error">{error}</div>}

      <div className="widget-session-actions">
        <span>
          <kbd>j/k</kbd> move
        </span>
        <span>
          <kbd>⏎</kbd> switch
        </span>
        <span>
          <kbd>r</kbd> rename
        </span>
        <span>
          <kbd>x</kbd> kill
        </span>
        <span>
          <kbd>d</kbd> detach
        </span>
        {canConnect && (
          <span>
            <kbd>c</kbd> connect
          </span>
        )}
        <span>
          <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  );
});
