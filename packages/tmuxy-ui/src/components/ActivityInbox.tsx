/**
 * The activity inbox (`prefix A`): every pane on the server that said
 * something about itself, across sessions, the one that wants the user most
 * first. Typing filters, the arrows move, Enter goes to the pane, Escape or
 * a click outside closes it.
 *
 * A combobox, like the session picker: the keyboard stays in the text box,
 * and the arrows move a highlight through the list instead of the focus.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { ComboboxInput } from './ComboboxInput';
import { useActiveOptionInView } from './useActiveOptionInView';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { activityPlace, filterActivity, type ActivityRow } from '../domain/activity';
import { PaneStateMark } from './PaneStateMark';
import './ActivityInbox.css';

/** How often the open inbox reads the panes again. */
const REFRESH_MS = 2000;

interface RowProps {
  id: string;
  row: ActivityRow;
  selected: boolean;
  onHighlight: () => void;
  onGo: () => void;
}

function Row({ id, row, selected, onHighlight, onGo }: RowProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={`activity-inbox-row${selected ? ' is-active' : ''}`}
      data-testid="activity-row"
      data-pane-id={row.paneId}
      data-state={row.state}
      // Hover moves the highlight; the press must not take the focus out of
      // the filter box.
      onPointerMove={onHighlight}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onGo}
    >
      <PaneStateMark state={row.state} className="activity-inbox-mark" keepSpace />
      <span className="activity-inbox-name">{row.name}</span>
      <span className="activity-inbox-said">{row.said}</span>
      <span className="activity-inbox-place">{activityPlace(row)}</span>
    </div>
  );
}

/** What the list says when it has no row to show. */
function Empty({ total, query }: { total: number; query: string }) {
  return (
    <div className="activity-inbox-empty" role="presentation">
      {total === 0 ? 'No pane has said anything about itself' : `No pane matches “${query.trim()}”`}
    </div>
  );
}

function List({ rows }: { rows: readonly ActivityRow[] }) {
  const send = useAppSend();
  const [query, setQuery] = useState('');
  const shown = filterActivity(rows, query);
  // The highlight is a pane, not a position: the list re-sorts as panes
  // change state, and the row under the highlight must not change with it.
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIndex = Math.max(
    0,
    shown.findIndex((row) => row.paneId === activeId),
  );
  const active: ActivityRow | undefined = shown[activeIndex];

  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (row: ActivityRow) => `${baseId}-${row.paneId.slice(1)}`;

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), []);
  useActiveOptionInView(listRef, active?.paneId);

  const go = (row: ActivityRow) => send({ type: 'ACTIVITY_GO', row });
  // A new filter starts the highlight over, on the most urgent match.
  const filter = (value: string) => {
    setQuery(value);
    setActiveId(null);
  };
  const step = (by: number) => {
    if (shown.length === 0) return;
    setActiveId(shown[(activeIndex + by + shown.length) % shown.length].paneId);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const control = event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === 'ArrowDown' || (control && (event.key === 'n' || event.key === 'j'))) {
      step(1);
    } else if (event.key === 'ArrowUp' || (control && (event.key === 'p' || event.key === 'k'))) {
      step(-1);
    } else if (event.key === 'Enter') {
      if (active) go(active);
    } else if (event.key === 'Escape') {
      send({ type: 'TOGGLE_ACTIVITY' });
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="activity-inbox-panel">
      <ComboboxInput
        inputRef={inputRef}
        className="activity-inbox-filter"
        label="Filter panes"
        listId={listId}
        activeId={active ? optionId(active) : undefined}
        placeholder="Filter panes…"
        value={query}
        onValue={filter}
        onKeyDown={onKeyDown}
      />
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Panes"
        className="activity-inbox-list"
      >
        {shown.map((row) => (
          <Row
            key={row.paneId}
            id={optionId(row)}
            row={row}
            selected={row.paneId === active?.paneId}
            onHighlight={() => setActiveId(row.paneId)}
            onGo={() => go(row)}
          />
        ))}
        {shown.length === 0 && <Empty total={rows.length} query={query} />}
      </div>
    </div>
  );
}

export function ActivityInbox() {
  const open = useAppSelector((ctx) => ctx.activityOpen);
  const rows = useAppSelector((ctx) => ctx.activityRows);
  const send = useAppSend();
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => send({ type: 'REFRESH_ACTIVITY' }), REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, send]);
  if (!open) return null;

  return (
    <div
      className="activity-inbox"
      data-testid="activity-inbox"
      role="dialog"
      aria-label="Activity"
    >
      <div className="activity-inbox-scrim" onClick={() => send({ type: 'TOGGLE_ACTIVITY' })} />
      <List rows={rows} />
    </div>
  );
}
