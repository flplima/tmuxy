/**
 * The command palette (Ctrl/Cmd+Shift+P, or `prefix P`): one box to type in,
 * over everything the app menu offers and every session, tab and pane to go
 * to. `prefix g` opens it on the places alone; typing `>` there brings the
 * actions back.
 *
 * A combobox, as the session switcher is: the keyboard stays in the text
 * box and the arrows move a highlight through the list
 * (`aria-activedescendant`).
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAppActor, useAppSelector, useAppSend } from '../../machines/appHooks';
import { submenuOpeners } from '../../domain/menus/spec';
import { rememberRecent, type PaletteMode } from '../../domain/palette/entries';
import { loadPaletteRecentPref, savePaletteRecentPref } from '../../infra/prefs';
import { ComboboxInput } from '../ComboboxInput';
import { useMenuEnv } from '../menus/menuEnv';
import { appMenuSpec } from '../menus/specs/appMenu';
import { useAppMenuSurface, type AppMenuSurface } from '../menus/useAppMenuSurface';
import type { AppPaletteEntry } from './paletteEntries';
import { paletteKeyOf } from './paletteKeys';
import { PaletteList } from './PaletteList';
import { usePaletteRows } from './usePaletteRows';
import './CommandPalette.css';

/** What Alt+↑/↓ and PageUp/PageDown move by. */
const PAGE = 8;

export function CommandPalette() {
  const mode = useAppSelector((ctx) => ctx.palette);
  const env = useMenuEnv();
  // Held here, not in the dialog: a choice closes the dialog, and what it
  // opened (the Kill Session question) has to outlive it.
  const surface = useAppMenuSurface(env);
  return (
    <>
      {mode && <PaletteDialog key={mode} mode={mode} surface={surface} />}
      {surface.dialogs}
    </>
  );
}

/**
 * What a submenu reads when it opens (the trace settings), the palette reads
 * when it does: it lists those items without anything opening.
 */
function useSubmenuReads({ dispatch, options }: AppMenuSurface) {
  const actor = useAppActor();
  const env = useMenuEnv();
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    const spec = appMenuSpec(actor.getSnapshot().context, env, options);
    for (const action of submenuOpeners(spec)) dispatch(action);
  }, [actor, env, options, dispatch]);
}

/** The highlight among `choices`: the first row until the arrows or the pointer move it. */
function useHighlight(choices: readonly AppPaletteEntry[]) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const index = Math.max(
    0,
    choices.findIndex((entry) => entry.id === activeId),
  );
  const to = (next: number) => {
    if (choices.length === 0) return;
    setActiveId(choices[Math.max(0, Math.min(choices.length - 1, next))].id);
  };
  return {
    active: choices[index] as AppPaletteEntry | undefined,
    setActiveId,
    /** One row on, wrapping at the ends. */
    step: (by: number) => to((index + by + choices.length) % choices.length),
    /** Several rows on, stopping at the ends. */
    page: (by: number) => to(index + by * PAGE),
    end: (which: 'first' | 'last') => to(which === 'first' ? 0 : choices.length - 1),
  };
}

/** The box takes the keyboard when the palette opens, and the list keeps the highlighted row in view. */
function usePaletteRefs(activeId: string | undefined) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);
  return { inputRef, listRef };
}

function PaletteDialog({ mode, surface }: { mode: PaletteMode; surface: AppMenuSurface }) {
  const send = useAppSend();
  const { dispatch, options } = surface;
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(loadPaletteRecentPref);
  const { rows, choices, needle } = usePaletteRows(mode, query, recent, options);
  const { active, setActiveId, step, page, end } = useHighlight(choices);
  useSubmenuReads(surface);

  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (entry: AppPaletteEntry) => `${baseId}-${entry.id}`;

  const { inputRef, listRef } = usePaletteRefs(active?.id);
  const close = useCallback(() => send({ type: 'CLOSE_PALETTE' }), [send]);

  /** New text is a new list: the highlight goes back to its first row. */
  const onQuery = useCallback(
    (text: string) => {
      setQuery(text);
      setActiveId(null);
    },
    [setActiveId],
  );

  const choose = (entry: AppPaletteEntry) => {
    const next = rememberRecent(recent, entry.id);
    setRecent(next);
    savePaletteRecentPref(next);
    // Closed first: what the action opens (a prompt, a dialog) takes the
    // keyboard after the palette has let go of it.
    close();
    dispatch(entry.action);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // A key that composes a character (an IME's Enter, its arrows) is the
    // composition's, not the list's.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const key = paletteKeyOf(event);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    if (key.kind === 'close') close();
    else if (key.kind === 'step') step(key.by);
    else if (key.kind === 'page') page(key.by);
    else if (key.kind === 'end') end(key.which);
    else if (key.kind === 'run' && active) choose(active);
  };

  const all = mode === 'all';
  return (
    <div className="command-palette" data-testid="command-palette" data-mode={mode}>
      <div className="command-palette-scrim" onPointerDown={close} />
      <div
        className="command-palette-panel"
        role="dialog"
        aria-label={all ? 'Command palette' : 'Go to session, tab or pane'}
      >
        <ComboboxInput
          inputRef={inputRef}
          className="command-palette-input"
          label={all ? 'Search actions and places' : 'Search places'}
          listId={listId}
          activeId={active ? optionId(active) : undefined}
          placeholder={
            all
              ? 'Search actions, sessions, tabs and panes…'
              : 'Go to a session, tab or pane… (type > for actions)'
          }
          value={query}
          onValue={onQuery}
          onKeyDown={onKeyDown}
        />
        <PaletteList
          listRef={listRef}
          listId={listId}
          rows={rows}
          activeId={active?.id}
          optionId={optionId}
          empty={needle === '' ? 'Nothing to go to yet' : `Nothing matches “${needle}”`}
          onHover={(entry) => setActiveId(entry.id)}
          onChoose={choose}
        />
      </div>
    </div>
  );
}
