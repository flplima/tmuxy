/**
 * TmuxySession — the `session` widget: switch, rename, kill or detach the
 * session, and attach to another tmux server through the 4-step connect flow.
 *
 * Rendered as a tmuxy WIDGET, like the tree: a real pane runs
 * `tmuxy widget session` in a float, and this draws in place of its terminal.
 *
 * Four steps:
 *  - Step 1 — SERVERS: reach dot (`online` / `known` / `offline`), label,
 *    detail (`socket <name> · N sessions` or `ssh <user@host> · <socket> · <last_used>`),
 *    and `+ another server…` at the end. `x` forgets a saved server.
 *  - Step 2 — CONNECT FORM: `Connect to` (`[user@]host[:port]` or blank for
 *    this machine) + `tmux socket` + live read-back line (`→ ssh …, then tmux -L …`).
 *  - Step 3 — STAGED CONNECTING VIEW: 4 stages (`ssh`, `tmux -V`, `listing sessions`,
 *    `attach`) with `✓` / spinner / `·` / `✗` + verbatim stderr on failure.
 *  - Step 4 — SESSIONS · <server>: lists sessions on that server + `+ new session…`.
 *    When a server has 0 sessions, the cursor starts on `+ new session…`.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TmuxOp } from '../../../domain/commands';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  useAppState,
  useReadOnly,
} from '../../../machines/appHooks';
import { selectSessions } from '../../../machines/selectors/ui';
import { InlineRename } from '../../InlineRename';
import { formatServerDetail, resolveServerReachability, type Row } from './sessionHelpers';
import {
  SessionActionBar,
  SessionConnectForm,
  SessionConnectingView,
  SessionServerList,
} from './SessionSteps';

export const TmuxySession = memo(function TmuxySession() {
  const send = useAppSend();
  const sessions = useAppSelectorShallow(selectSessions);
  const servers = useAppSelectorShallow((ctx) => ctx.servers);
  const currentServerId = useAppSelector((ctx) => ctx.currentServerId);
  const serverProbe = useAppSelector((ctx) => ctx.serverProbe);
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const detached = useAppState('detached');

  const [cursor, setCursor] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [dest, setDest] = useState('');
  const [socket, setSocket] = useState('');

  const activeServerLabel = useMemo(() => {
    if (serverProbe?.status === 'done') return serverProbe.server.label;
    const current = servers.find((s) => s.id === currentServerId);
    return current?.label ?? 'localhost';
  }, [serverProbe, servers, currentServerId]);

  const isProbedServerStep4 =
    serverProbe?.status === 'done' && serverProbe.server.id !== (currentServerId ?? 'localhost');

  const sessionRows = useMemo<Row[]>(() => {
    if (serverProbe?.status === 'done') {
      const targetId = serverProbe.server.id;
      const isCurrentServer = targetId === (currentServerId ?? 'localhost');
      const remoteRows: Row[] = serverProbe.sessions.map((s) => ({
        kind: 'session' as const,
        name: s.name,
        windows: s.windows,
        current: isCurrentServer && s.name === sessionName,
        serverId: targetId,
      }));
      return [...remoteRows, { kind: 'new-session' as const, serverId: targetId }];
    }
    const names = sessions.length > 0 ? sessions.map((s) => s.sessionName) : [sessionName];
    const localRows: Row[] = names.map((name) => ({
      kind: 'session' as const,
      name,
      windows: sessions.find((s) => s.sessionName === name)?.windows.length ?? 0,
      current: name === sessionName,
      serverId: currentServerId,
    }));
    return [...localRows, { kind: 'new-session' as const, serverId: currentServerId }];
  }, [serverProbe, sessions, sessionName, currentServerId]);

  const serverRows = useMemo<Row[]>(() => {
    if (servers.length === 0 || isProbedServerStep4) return [];
    const mapped: Row[] = servers.map((server) => {
      const current =
        server.id === currentServerId ||
        (!currentServerId && (server.id === 'localhost' || server.id === 'my-tmux'));
      return {
        kind: 'server' as const,
        id: server.id,
        label: server.label,
        detail: formatServerDetail(server),
        current,
        reachable: resolveServerReachability(server, currentServerId),
        deletable: server.id !== 'localhost' && server.id !== 'my-tmux' && !current,
      };
    });
    return [...mapped, { kind: 'connect-server' as const }];
  }, [servers, currentServerId, isProbedServerStep4]);

  const rows = useMemo(() => [...sessionRows, ...serverRows], [sessionRows, serverRows]);
  const clampedCursor = Math.max(0, Math.min(cursor, Math.max(0, rows.length - 1)));
  const selected = rows[clampedCursor];

  // When a probed server finishes Step 3 (`done`), reset the cursor to row 0
  // (which is the first session, or `+ new session…` when 0 sessions exist).
  const probeDoneKey =
    serverProbe?.status === 'done' ? `${serverProbe.server.id}:${serverProbe.sessions.length}` : '';
  useEffect(() => {
    if (probeDoneKey) setCursor(0);
  }, [probeDoneKey]);

  const readOnly = useReadOnly();
  const close = useCallback(() => send({ type: 'CLOSE_TOP_FLOAT' }), [send]);
  const canConnect = servers.length > 0;

  const openConnect = useCallback(() => {
    if (canConnect) {
      setConnecting(true);
      setError(null);
    }
  }, [canConnect]);

  const activate = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === 'connect-server') {
        openConnect();
        return;
      }
      if (row.kind === 'new-session') {
        if (!readOnly) setCreatingSession(true);
        return;
      }
      if (row.kind === 'session') {
        const isRemote =
          row.serverId &&
          row.serverId !== currentServerId &&
          row.serverId !== 'localhost' &&
          row.serverId !== 'my-tmux';
        if (isRemote) {
          send({ type: 'CONNECT_SERVER', serverId: row.serverId!, session: row.name });
        } else if (!row.current) {
          send({ type: 'SWITCH_SESSION', sessionName: row.name });
        }
        close();
        return;
      }
      if (row.kind === 'server') {
        if (!row.current || detached) {
          send({ type: 'CONNECT_SERVER', serverId: row.id });
        }
        close();
      }
    },
    [send, close, detached, openConnect, readOnly, currentServerId],
  );

  const deleteSelected = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === 'server') {
        if (!row.deletable) {
          setError('Cannot forget the active or default local server.');
          return;
        }
        send({ type: 'REMOVE_SERVER', serverId: row.id });
        setError(null);
        return;
      }
      if (row.kind !== 'session') return;
      if (row.current) {
        setError('Switch to another session before killing this one.');
        return;
      }
      send({ type: 'DISPATCH_OP', op: TmuxOp.KillSession({ name: row.name }) });
      setError(null);
    },
    [send],
  );

  const detach = useCallback(() => {
    if (isProbedServerStep4) {
      send({ type: 'CANCEL_SERVER_PROBE' });
      return;
    }
    close();
    send({ type: 'DETACH_CLIENT' });
  }, [send, close, isProbedServerStep4]);

  const submitConnect = useCallback(() => {
    const trimmedDest = dest.trim();
    const trimmedSocket = socket.trim() || undefined;
    send({ type: 'ADD_SERVER', dest: trimmedDest, socket: trimmedSocket, probe: true });
    setConnecting(false);
    setDest('');
    setSocket('');
    setError(null);
  }, [send, dest, socket]);

  const commitNewSession = useCallback(
    (name: string) => {
      setCreatingSession(false);
      const trimmed = name.trim();
      if (!trimmed) return;
      if (isProbedServerStep4 && serverProbe) {
        send({
          type: 'CONNECT_SERVER',
          serverId: serverProbe.server.id,
          session: trimmed,
        });
        close();
        return;
      }
      send({ type: 'DISPATCH_OP', op: TmuxOp.NewSession({ name: trimmed }) });
      send({ type: 'SWITCH_SESSION', sessionName: trimmed });
      close();
    },
    [send, close, isProbedServerStep4, serverProbe],
  );

  const commitRename = useCallback(
    (name: string) => {
      setRenaming(false);
      if (selected?.kind !== 'session') return;
      send({
        type: 'DISPATCH_OP',
        op: TmuxOp.RenameSession({ session: selected.name, name }),
      });
    },
    [send, selected],
  );

  const isStep3 =
    serverProbe !== null && (serverProbe.status === 'running' || serverProbe.status === 'failed');

  const retryProbe = useCallback(() => {
    if (!serverProbe) return;
    send({
      type: 'PROBE_SERVER',
      serverId: serverProbe.server.id,
      dest:
        serverProbe.server.kind === 'ssh' && serverProbe.server.ssh
          ? `${serverProbe.server.ssh.user ? `${serverProbe.server.ssh.user}@` : ''}${serverProbe.server.ssh.host}`
          : undefined,
      socket: serverProbe.server.socket,
    });
  }, [send, serverProbe]);

  const cancelProbe = useCallback(() => {
    send({ type: 'CANCEL_SERVER_PROBE' });
  }, [send]);

  const stateRef = useRef({
    rows,
    cursor: clampedCursor,
    activate,
    deleteSelected,
    detach,
    close,
    renaming,
    creatingSession,
    connecting,
    isStep3,
    probeStatus: serverProbe?.status ?? null,
    retryProbe,
    cancelProbe,
    openConnect,
    canConnect,
    isProbedServerStep4,
    readOnly,
  });
  stateRef.current = {
    rows,
    cursor: clampedCursor,
    activate,
    deleteSelected,
    detach,
    close,
    renaming,
    creatingSession,
    connecting,
    isStep3,
    probeStatus: serverProbe?.status ?? null,
    retryProbe,
    cancelProbe,
    openConnect,
    canConnect,
    isProbedServerStep4,
    readOnly,
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (s.renaming || s.creatingSession || s.connecting) return;
      const claim = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (s.isStep3) {
        if (e.key === 'Escape' || (s.probeStatus === 'failed' && e.key === 'x')) {
          claim();
          s.cancelProbe();
          return;
        }
        if (s.probeStatus === 'failed' && e.key === 'Enter') {
          claim();
          s.retryProbe();
          return;
        }
        if (!e.ctrlKey && !e.altKey && !e.metaKey) e.stopImmediatePropagation();
        return;
      }
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
          if (!s.readOnly && s.rows[s.cursor]?.kind === 'session') setRenaming(true);
          return;
        case 'x':
          claim();
          if (!s.readOnly) s.deleteSelected(s.rows[s.cursor]);
          return;
        case 'd':
        case 'D':
          claim();
          if (!s.readOnly) s.detach();
          return;
        case 'c':
          claim();
          if (s.canConnect && !s.isProbedServerStep4) {
            s.openConnect();
          } else if (!s.readOnly) {
            setCreatingSession(true);
          }
          return;
        case 'Escape':
        case 'q':
          claim();
          if (s.isProbedServerStep4) {
            s.cancelProbe();
          } else {
            s.close();
          }
          return;
        default:
          if (!e.ctrlKey && !e.altKey && !e.metaKey) e.stopImmediatePropagation();
          return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  return (
    <div className="widget-session" data-testid="session-switcher">
      {isStep3 && serverProbe ? (
        <SessionConnectingView probe={serverProbe} onRetry={retryProbe} onCancel={cancelProbe} />
      ) : (
        <>
          <div className="widget-session-heading" data-testid="session-list-heading">
            Sessions · {activeServerLabel}
          </div>
          <div className="widget-session-list" role="listbox" aria-label="Sessions">
            {sessionRows.map((row, i) => {
              const isSelected = rows[clampedCursor] === row;
              if (row.kind === 'new-session') {
                return (
                  <div
                    key="s:__new__"
                    role="option"
                    aria-selected={isSelected}
                    className={`widget-session-row widget-session-action-row${
                      isSelected ? ' is-selected' : ''
                    }`}
                    data-testid="session-new-row"
                    onClick={() => {
                      setCursor(i);
                      activate(row);
                    }}
                  >
                    {creatingSession ? (
                      <InlineRename
                        value=""
                        testId="session-new-input"
                        ariaLabel="New session name"
                        onCommit={commitNewSession}
                        onCancel={() => setCreatingSession(false)}
                      />
                    ) : (
                      <span className="widget-session-name">+ new session…</span>
                    )}
                  </div>
                );
              }
              return (
                <div
                  key={`s:${row.kind === 'session' ? row.name : ''}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`widget-session-row${isSelected ? ' is-selected' : ''}${
                    row.kind === 'session' && row.current ? ' is-current' : ''
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
                      <span className="widget-session-name">
                        {row.kind === 'session' && row.name}
                      </span>
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

          <SessionServerList
            serverRows={serverRows}
            selectedRow={rows[clampedCursor]}
            sessionRowsCount={sessionRows.length}
            onSelect={(idx, row) => {
              setCursor(idx);
              activate(row);
            }}
          />

          {connecting && (
            <SessionConnectForm
              dest={dest}
              socket={socket}
              onDestChange={setDest}
              onSocketChange={setSocket}
              onSubmit={submitConnect}
              onCancel={() => setConnecting(false)}
            />
          )}
        </>
      )}

      {error && <div className="widget-session-error">{error}</div>}

      <SessionActionBar
        isFailedProbe={isStep3 && serverProbe?.status === 'failed'}
        selected={selected}
        readOnly={readOnly}
        canConnect={canConnect}
        isProbedServerStep4={Boolean(isProbedServerStep4)}
      />
    </div>
  );
});
