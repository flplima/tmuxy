/**
 * The palette's rows for what is typed: grouped under headings while the box
 * is empty, ranked by the match once it is not.
 */

import { useMemo } from 'react';
import { useAppSelector } from '../../machines/appHooks';
import { entryText, recentFirst, type PaletteMode } from '../../domain/palette/entries';
import { rank } from '../../domain/palette/fuzzy';
import { useMenuEnv } from '../menus/menuEnv';
import type { AppMenuOptions } from '../menus/specs/appMenu';
import {
  newSessionEntry,
  paletteEntries,
  type AppPaletteEntry,
  type PaletteEntries,
} from './paletteEntries';

/** A search shows this many rows at most: past it, typing more is the way on. */
const MAX_RESULTS = 60;

export type PaletteRow =
  | { kind: 'header'; label: string }
  | { kind: 'entry'; entry: AppPaletteEntry; positions: readonly number[] };

function section(label: string, entries: readonly AppPaletteEntry[]): PaletteRow[] {
  if (entries.length === 0) return [];
  return [
    { kind: 'header', label },
    ...entries.map((entry): PaletteRow => ({ kind: 'entry', entry, positions: [] })),
  ];
}

/** Untyped: what was run last, then each kind under its heading. */
function grouped(
  entries: PaletteEntries,
  everything: boolean,
  recent: readonly string[],
): PaletteRow[] {
  const all = [...entries.actions, ...entries.sessions, ...entries.tabs, ...entries.panes];
  // Among everything, what was run last comes first and is not repeated below.
  const split = recentFirst(all, everything ? recent : []);
  const rest = new Set(split.rest);
  const left = (list: readonly AppPaletteEntry[]) => list.filter((entry) => rest.has(entry));
  return [
    ...section('Recent', split.recent),
    ...(everything ? section('Actions', left(entries.actions)) : []),
    ...section('Sessions', left(entries.sessions)),
    ...section('Tabs', left(entries.tabs)),
    ...section('Panes', left(entries.panes)),
  ];
}

/** Typed: the entries that match, best first. */
function matching(entries: PaletteEntries, everything: boolean, needle: string): PaletteRow[] {
  const places = [...entries.sessions, ...entries.tabs, ...entries.panes];
  const pool = everything ? [...entries.actions, ...places] : places;
  return rank(
    pool.map((entry) => ({ entry, label: entry.label, extra: entryText(entry) })),
    needle,
  )
    .slice(0, MAX_RESULTS)
    .map(({ item, positions }) => ({ kind: 'entry', entry: item.entry, positions }));
}

export interface PaletteRows {
  rows: PaletteRow[];
  /** The rows that can be chosen, in order. */
  choices: AppPaletteEntry[];
  /** What is searched for: the query without the `>` that asks for the actions. */
  needle: string;
}

export function usePaletteRows(
  mode: PaletteMode,
  query: string,
  recent: readonly string[],
  options: AppMenuOptions,
): PaletteRows {
  const env = useMenuEnv();
  const ctx = useAppSelector((context) => context);
  // `>` asks for the actions from the places-only list, as it does in an editor.
  const everything = mode === 'all' || query.trimStart().startsWith('>');
  const needle = query.trimStart().replace(/^>/, '').trim();
  const entries = useMemo(() => paletteEntries(ctx, env, options), [ctx, env, options]);
  const rows = useMemo(() => {
    if (needle === '') return grouped(entries, everything, recent);
    const found = matching(entries, everything, needle);
    // Among the places, a typed name no session has can become one. Not
    // among everything: there a mistyped action would be one Enter away from
    // a session named after the typo.
    const named = everything ? null : newSessionEntry(ctx, env, needle);
    return named ? [...found, { kind: 'entry' as const, entry: named, positions: [] }] : found;
  }, [entries, ctx, env, needle, everything, recent]);
  const choices = useMemo(
    () => rows.flatMap((row) => (row.kind === 'entry' ? [row.entry] : [])),
    [rows],
  );
  return { rows, choices, needle };
}
