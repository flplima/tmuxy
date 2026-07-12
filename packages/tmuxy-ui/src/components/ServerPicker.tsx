/**
 * ServerPicker — the sidebar footer showing the current tmux server, with a
 * popover to switch servers or add a new one.
 *
 * Desktop-only: the wiring in Sidebar.tsx renders this only under Tauri (the
 * web build is fixed to its launch socket). This component itself is a pure
 * presentational popover — data and callbacks come from props — so it renders
 * identically in Storybook/tests without a Tauri runtime.
 *
 * "Add server…" opens the `tmuxy connect` form in a float (via the caller's
 * `onAddServer`); selecting a server reconnects the app to it (`onSelect`).
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { ServerInfo } from '../machines/types';

export interface ServerPickerProps {
  servers: ServerInfo[];
  currentId: string;
  onSelect: (id: string) => void;
  onAddServer: () => void;
}

export const ServerPicker = memo(function ServerPicker({
  servers,
  currentId,
  onSelect,
  onAddServer,
}: ServerPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = servers.find((s) => s.id === currentId);
  const currentLabel = current?.label ?? 'localhost';

  // Close the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="sidebar-footer" ref={rootRef} data-testid="server-picker">
      <button
        type="button"
        className="server-picker-current"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        data-testid="server-picker-toggle"
      >
        <span className="server-picker-icon" aria-hidden="true">
          {current?.kind === 'ssh' ? '🌐' : '🖥'}
        </span>
        <span className="server-picker-label">{currentLabel}</span>
        <span className="server-picker-caret" aria-hidden="true">
          {open ? '▾' : '▴'}
        </span>
      </button>

      {open && (
        <div className="server-picker-menu" role="menu" data-testid="server-picker-menu">
          {servers.map((s) => (
            <button
              type="button"
              key={s.id}
              role="menuitem"
              className={`server-picker-item${s.id === currentId ? ' is-current' : ''}`}
              data-testid={`server-picker-item-${s.id}`}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                if (s.id !== currentId) onSelect(s.id);
              }}
            >
              <span className="server-picker-icon" aria-hidden="true">
                {s.kind === 'ssh' ? '🌐' : '🖥'}
              </span>
              <span className="server-picker-label">{s.label}</span>
              {s.id === currentId && (
                <span className="server-picker-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
          <div className="server-picker-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="server-picker-item server-picker-add"
            data-testid="server-picker-add"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onAddServer();
            }}
          >
            <span className="server-picker-icon" aria-hidden="true">
              ＋
            </span>
            <span className="server-picker-label">Add server…</span>
          </button>
        </div>
      )}
    </div>
  );
});
