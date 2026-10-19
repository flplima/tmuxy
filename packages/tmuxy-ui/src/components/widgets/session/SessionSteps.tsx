import type { ServerProbeState } from '../../../machines/types/domain';
import { formatConnectReadback, type Row } from './sessionHelpers';

/** Step 3 — Staged connecting view (`[data-testid="session-connecting-view"]`). */
export function SessionConnectingView({
  probe,
  onRetry,
  onCancel,
}: {
  probe: ServerProbeState;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="widget-session-connecting"
      data-testid="session-connecting-view"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (probe.status === 'failed' && e.key === 'x')) {
          e.preventDefault();
          onCancel();
        } else if (probe.status === 'failed' && e.key === 'Enter') {
          e.preventDefault();
          onRetry();
        }
      }}
    >
      <div className="widget-session-heading" data-testid="session-connecting-title">
        <span>{probe.server.label}</span>
        {probe.status === 'running' && (
          <span className="widget-session-spinner" aria-label="Working">
            ⠋
          </span>
        )}
      </div>
      <div className="widget-session-stages" role="list" aria-label="Connection stages">
        {probe.stages.map((stage) => {
          const icon =
            stage.status === 'done'
              ? '✓'
              : stage.status === 'failed'
                ? '✗'
                : stage.status === 'running'
                  ? '⠋'
                  : '·';
          return (
            <div
              key={stage.name}
              role="listitem"
              className={`widget-session-stage is-${stage.status}`}
              data-testid={`session-stage-${stage.name}`}
            >
              <div className="widget-session-stage-line">
                <span className="widget-session-stage-icon" aria-hidden="true">
                  {icon}
                </span>
                <span className="widget-session-stage-label">{stage.label}</span>
                {typeof stage.elapsed_ms === 'number' && (
                  <span className="widget-session-stage-elapsed">{stage.elapsed_ms}ms</span>
                )}
              </div>
              {stage.status === 'failed' && stage.error && (
                <pre
                  className="widget-session-stage-error"
                  data-testid={`session-stage-error-${stage.name}`}
                >
                  {stage.error}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Step 2 — Connect Form (`[data-testid="session-connect-form"]`). */
export function SessionConnectForm({
  dest,
  socket,
  onDestChange,
  onSocketChange,
  onSubmit,
  onCancel,
}: {
  dest: string;
  socket: string;
  onDestChange: (value: string) => void;
  onSocketChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="widget-session-form"
      data-testid="session-connect-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      onKeyDown={(e) => {
        // The fields own every key, including the app's own bindings.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
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
          onChange={(e) => onDestChange(e.target.value)}
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
          onChange={(e) => onSocketChange(e.target.value)}
        />
      </div>
      <div className="widget-session-readback" data-testid="session-connect-readback">
        {formatConnectReadback(dest, socket)}
      </div>
      <p className="widget-session-hint">
        Keys, ports and jump hosts come from your ~/.ssh/config — tmuxy runs your own ssh.
      </p>
    </form>
  );
}

/** Step 1 — Server rows + `+ another server…` (`[aria-label="Servers"]`). */
export function SessionServerList({
  serverRows,
  selectedRow,
  sessionRowsCount,
  onSelect,
}: {
  serverRows: Row[];
  selectedRow: Row | undefined;
  sessionRowsCount: number;
  onSelect: (index: number, row: Row) => void;
}) {
  if (serverRows.length === 0) return null;
  return (
    <>
      <div className="widget-session-heading">Servers</div>
      <div className="widget-session-list" role="listbox" aria-label="Servers">
        {serverRows.map((row, i) => {
          const isSelected = selectedRow === row;
          if (row.kind === 'connect-server') {
            return (
              <div
                key="v:__connect__"
                role="option"
                aria-selected={isSelected}
                className={`widget-session-row widget-session-action-row${
                  isSelected ? ' is-selected' : ''
                }`}
                data-testid="session-connect-row"
                onClick={() => onSelect(sessionRowsCount + i, row)}
              >
                <span className="widget-session-name">+ another server…</span>
              </div>
            );
          }
          return (
            <div
              key={`v:${row.kind === 'server' ? row.id : ''}`}
              role="option"
              aria-selected={isSelected}
              className={`widget-session-row${isSelected ? ' is-selected' : ''}${
                row.kind === 'server' && row.current ? ' is-current' : ''
              }`}
              data-testid={`server-row-${row.kind === 'server' ? row.id : ''}`}
              onClick={() => onSelect(sessionRowsCount + i, row)}
            >
              {row.kind === 'server' && (
                <>
                  <span
                    className={`widget-session-reach-dot is-${row.reachable}`}
                    data-testid="server-reach-dot"
                    aria-label={row.reachable}
                  >
                    {row.reachable === 'offline' ? '○' : '●'}
                  </span>
                  <span className="widget-session-name">{row.label}</span>
                  <span className="widget-session-meta">{row.detail}</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Bottom verb chips bar — never lists `esc`. */
export function SessionActionBar({
  isFailedProbe,
  selected,
  readOnly,
  canConnect,
  isProbedServerStep4,
}: {
  isFailedProbe: boolean;
  selected: Row | undefined;
  readOnly: boolean;
  canConnect: boolean;
  isProbedServerStep4: boolean;
}) {
  return (
    <div className="widget-session-actions">
      {isFailedProbe ? (
        <>
          <span>
            <kbd>⏎</kbd> retry
          </span>
          <span>
            <kbd>x</kbd> cancel
          </span>
        </>
      ) : (
        <>
          <span>
            <kbd>j/k</kbd> move
          </span>
          <span>
            <kbd>⏎</kbd> {selected?.kind === 'server' ? 'connect' : 'switch'}
          </span>
          {!readOnly && (
            <>
              <span>
                <kbd>r</kbd> rename
              </span>
              <span>
                <kbd>x</kbd> {selected?.kind === 'server' ? 'forget' : 'kill'}
              </span>
              <span>
                <kbd>d</kbd> detach
              </span>
            </>
          )}
          {canConnect && !isProbedServerStep4 ? (
            <span>
              <kbd>c</kbd> connect
            </span>
          ) : (
            !readOnly && (
              <span>
                <kbd>c</kbd> new
              </span>
            )
          )}
        </>
      )}
    </div>
  );
}
