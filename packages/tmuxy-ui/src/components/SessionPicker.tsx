/**
 * SessionPicker — the session switcher's body: a filter box over the list it
 * narrows (`sessionSwitcherSpec`). The status line's dropdown (SessionMenu)
 * and the detached overlay (SessionList) both draw it.
 *
 * A menu was enough for four sessions. A dozen ran off the screen, and finding
 * one among them meant reading every row. So the list scrolls inside a capped
 * box, and the box above it filters as you type.
 *
 * It is a combobox rather than a menu: the keyboard stays in the text box,
 * where typing has to go, and the arrows move a highlight through the list
 * instead of the focus (`aria-activedescendant`). Enter picks the highlighted
 * row, so typing a few letters and Enter is a whole switch.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useAppSelector } from '../machines/appHooks';
import { sessionSwitcherSpec } from '../domain/menus/sessionSwitcher';
import type { MenuNode } from '../domain/menus/spec';
import { MenuIcon } from './menus/MenuIcons';
import { dataAttributes } from './menus/SpecMenu';
import { useMenuEnv } from './menus/menuEnv';
import './SessionPicker.css';

export type SwitcherItem = Extract<MenuNode, { kind: 'item' }>;

const CONNECT_ID = 'session-connect';

interface SessionPickerProps {
  onChoose: (item: SwitcherItem) => void;
  /** Escape in the filter box. The overlay leaves it out: it has nothing to close. */
  onEscape?: () => void;
  /** False on the detached overlay: the connect flow opens a float, which needs a session. */
  withConnect?: boolean;
}

export function SessionPicker({ onChoose, onEscape, withConnect = true }: SessionPickerProps) {
  const env = useMenuEnv();
  const [query, setQuery] = useState('');
  const spec = useAppSelector((ctx) => sessionSwitcherSpec(ctx, env, query));
  const nodes = withConnect
    ? spec
    : spec.filter((n) => !(n.kind === 'item' && n.id === CONNECT_ID));
  const items = nodes.filter((n): n is SwitcherItem => n.kind === 'item');

  // The highlight starts on the session you are on, so the arrows step from
  // where you are; once you type, it moves to the first match.
  const [activeId, setActiveId] = useState<string | null>(
    () => items.find((item) => item.data?.current)?.id ?? null,
  );
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );
  const active: SwitcherItem | undefined = items[activeIndex];

  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (item: SwitcherItem) => `${baseId}-${item.id}`;

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), []);
  // The highlighted row stays in view as the arrows walk past the list's edge.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active?.id]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const step = (by: number) => {
      if (items.length === 0) return;
      setActiveId(items[(activeIndex + by + items.length) % items.length].id);
    };
    switch (event.key) {
      case 'ArrowDown':
        step(1);
        break;
      case 'ArrowUp':
        step(-1);
        break;
      case 'Enter':
        if (active) onChoose(active);
        break;
      case 'Escape':
        if (!onEscape) return;
        onEscape();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const named = items.some((item) => item.id !== CONNECT_ID);

  return (
    <div className="session-picker">
      <input
        ref={inputRef}
        className="session-picker-filter"
        type="text"
        role="combobox"
        aria-label="Filter sessions"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(active) : undefined}
        placeholder="Filter sessions…"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveId(null);
        }}
        onKeyDown={onKeyDown}
      />
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Sessions"
        className="session-picker-list"
      >
        {nodes.map((node, index) => {
          if (node.kind === 'header') {
            return (
              <div
                key={`header-${node.label}`}
                className="session-picker-header"
                role="presentation"
              >
                {node.label}
              </div>
            );
          }
          if (node.kind === 'separator') {
            return (
              <div key={`sep-${index}`} className="session-picker-divider" role="presentation" />
            );
          }
          if (node.kind !== 'item') return null;
          const selected = node.id === active?.id;
          return (
            <div
              key={node.id}
              id={optionId(node)}
              role="option"
              aria-selected={selected}
              className={`session-picker-item${selected ? ' is-active' : ''}${
                node.className ? ` ${node.className}` : ''
              }`}
              data-testid={node.testId}
              {...dataAttributes(node.data)}
              // Moving over a row is choosing where the highlight is, as in a
              // menu; the focus stays in the box so typing goes on working.
              onPointerMove={() => setActiveId(node.id)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onChoose(node)}
            >
              <span className="menu-item-lead" aria-hidden="true">
                {node.icon && <MenuIcon name={node.icon} />}
              </span>
              {node.label}
            </div>
          );
        })}
        {!named && (
          <div className="session-picker-empty" role="presentation">
            {`No session matches “${query.trim()}”`}
          </div>
        )}
      </div>
    </div>
  );
}
