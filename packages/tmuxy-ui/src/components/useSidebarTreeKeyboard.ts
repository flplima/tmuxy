import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { expandableKey, rowKey, type SidebarTreeRow } from './sidebarTreeModel';

interface SidebarTreeKeyboardOptions {
  focused: boolean;
  rows: SidebarTreeRow[];
  selectedIndex: number;
  collapsed: ReadonlySet<string>;
  setSelectedKey: Dispatch<SetStateAction<string | null>>;
  focusRow: (index: number) => void;
  activate: (row: SidebarTreeRow) => void;
  toggleExpanded: (row: SidebarTreeRow) => void;
  blur: () => void;
}

/** Own capture-phase keyboard navigation while the sidebar has focus. */
export function useSidebarTreeKeyboard(options: SidebarTreeKeyboardOptions): void {
  const stateRef = useRef(options);
  stateRef.current = options;

  useEffect(() => {
    if (!options.focused) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const focusedTwisty =
        (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') &&
        target?.closest<HTMLButtonElement>('.sidebar-tree-twisty');
      if (focusedTwisty) {
        event.preventDefault();
        event.stopImmediatePropagation();
        // Perform the native button action explicitly while retaining the
        // sidebar's capture-phase guarantee that keys never leak to tmux.
        focusedTwisty.click();
        return;
      }

      const {
        rows,
        selectedIndex,
        collapsed,
        setSelectedKey,
        focusRow,
        activate,
        toggleExpanded,
        blur,
      } = stateRef.current;
      const selected = rows[selectedIndex];
      const move = (delta: number) => {
        const next = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta));
        if (!rows[next]) return;
        setSelectedKey(rowKey(rows[next]));
        focusRow(next);
      };

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          event.preventDefault();
          event.stopImmediatePropagation();
          move(1);
          return;
        case 'k':
        case 'ArrowUp':
          event.preventDefault();
          event.stopImmediatePropagation();
          move(-1);
          return;
        case 'ArrowRight': {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!selected) return;
          const key = expandableKey(selected);
          if (key && collapsed.has(key)) {
            toggleExpanded(selected);
            focusRow(selectedIndex);
          } else if (rows[selectedIndex + 1]?.depth > selected.depth) {
            move(1);
          }
          return;
        }
        case 'ArrowLeft': {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!selected) return;
          const key = expandableKey(selected);
          if (key && !collapsed.has(key)) {
            toggleExpanded(selected);
            focusRow(selectedIndex);
            return;
          }
          for (let parentIndex = selectedIndex - 1; parentIndex >= 0; parentIndex -= 1) {
            if (rows[parentIndex].depth < selected.depth) {
              setSelectedKey(rowKey(rows[parentIndex]));
              focusRow(parentIndex);
              break;
            }
          }
          return;
        }
        case 'Enter':
          event.preventDefault();
          event.stopImmediatePropagation();
          if (selected) activate(selected);
          return;
        case 'Escape':
          event.preventDefault();
          event.stopImmediatePropagation();
          blur();
          return;
        default:
          event.stopImmediatePropagation();
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [options.focused]);
}
