/** The palette's results: headings and the rows under them, one of them highlighted. */

import { MenuIcon } from '../menus/MenuIcons';
import type { AppPaletteEntry } from './paletteEntries';
import type { PaletteRow } from './usePaletteRows';

/** `label` with the matched letters marked. */
function Marked({ label, positions }: { label: string; positions: readonly number[] }) {
  if (positions.length === 0) return <>{label}</>;
  const marked = new Set(positions);
  const parts: React.ReactNode[] = [];
  let run = '';
  let runMarked = false;
  const flush = (key: number) => {
    if (run === '') return;
    parts.push(runMarked ? <mark key={key}>{run}</mark> : run);
    run = '';
  };
  for (let i = 0; i < label.length; i++) {
    if (marked.has(i) !== runMarked) {
      flush(i);
      runMarked = marked.has(i);
    }
    run += label[i];
  }
  flush(label.length);
  return <>{parts}</>;
}

/** A checked row wears the check; a place the arrow; an action its menu icon, when it has one. */
function Lead({ entry }: { entry: AppPaletteEntry }) {
  if (entry.checked) return <MenuIcon name="check" />;
  if (entry.checked !== undefined) return null;
  const icon = entry.icon ?? (entry.kind === 'action' ? undefined : 'go-to');
  return icon ? <MenuIcon name={icon} /> : null;
}

interface PaletteListProps {
  listRef: React.Ref<HTMLDivElement>;
  listId: string;
  rows: readonly PaletteRow[];
  activeId: string | undefined;
  optionId: (entry: AppPaletteEntry) => string;
  /** The row Enter was pressed on once and that waits for the second press. */
  armedId: string | null;
  /** What to say when there is nothing to choose. */
  empty: string;
  /** A click on a row: aimed, so it runs the row whatever it is. */
  onChoose: (entry: AppPaletteEntry) => void;
}

export function PaletteList({
  listRef,
  listId,
  rows,
  activeId,
  optionId,
  armedId,
  empty,
  onChoose,
}: PaletteListProps) {
  const none = !rows.some((row) => row.kind === 'entry');
  return (
    <>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Results"
        className="command-palette-list"
      >
        {rows.map((row) => {
          if (row.kind === 'header') {
            return (
              <div
                key={`header-${row.label}`}
                className="command-palette-header"
                role="presentation"
              >
                {row.label}
              </div>
            );
          }
          const { entry } = row;
          const selected = entry.id === activeId;
          return (
            <div
              key={entry.id}
              id={optionId(entry)}
              role="option"
              aria-selected={selected}
              className={`command-palette-item${selected ? ' is-active' : ''}`}
              data-entry-id={entry.id}
              data-entry-kind={entry.kind}
              data-checked={entry.checked}
              // Hover does not move the highlight: Enter runs the row the
              // keys are on, never the one the pointer happens to rest over.
              onClick={() => onChoose(entry)}
            >
              <span className="menu-item-lead" aria-hidden="true">
                <Lead entry={entry} />
              </span>
              <span className="command-palette-label">
                <Marked label={entry.label} positions={row.positions} />
              </span>
              {entry.detail && <span className="command-palette-detail">{entry.detail}</span>}
              {armedId === entry.id ? (
                <span className="command-palette-confirm">Enter again to run</span>
              ) : (
                entry.keyHint && <kbd className="command-palette-key">{entry.keyHint}</kbd>
              )}
            </div>
          );
        })}
      </div>
      {/* Outside the listbox, and a status: an empty list is said, not silent. */}
      <div className="command-palette-empty" role="status">
        {none ? empty : ''}
      </div>
    </>
  );
}
