/**
 * What the command palette lists, from the machine's context: the app menu's
 * items walked flat, and the places to go — the other sessions, and the tabs
 * and panes of every session on the socket.
 */

import type { AppMachineContext } from '../../machines/types/context';
import type { MenuEnv } from '../../domain/menus/spec';
import { specEntries, type PaletteEntry } from '../../domain/palette/entries';
import { sessionNameFrom } from '../../domain/sessionNames';
import { stripTabs } from '../../domain/windows';
import { appMenuSpec, PALETTE_ITEM_IDS, type AppMenuOptions } from '../menus/specs/appMenu';
import { event, type AppMenuAction } from '../menus/specs/actions';
import { buildTreeRows } from '../sidebarTreeRows';
import { paneRowLines } from '../paneTabDisplay';

export type AppPaletteEntry = PaletteEntry<AppMenuAction>;

export interface PaletteEntries {
  actions: AppPaletteEntry[];
  sessions: AppPaletteEntry[];
  tabs: AppPaletteEntry[];
  panes: AppPaletteEntry[];
}

const OWN_ITEMS: ReadonlySet<string> = new Set(Object.values(PALETTE_ITEM_IDS));
const NO_TABS: ReadonlySet<never> = new Set();

/** A pane's row: the program, then what it says it is showing when that adds something. */
function paneLabel(process: string, title: string): string {
  return title && title !== process ? `${process}  ${title}` : process;
}

/** The other sessions to switch to, and the saved ones that are not running. */
function sessionEntries(ctx: AppMachineContext): AppPaletteEntry[] {
  const { sessionName } = ctx;
  const running = ctx.sessions.map((s) => s.sessionName);
  return [
    ...running
      .filter((name) => name !== sessionName)
      .map(
        (name): AppPaletteEntry => ({
          id: `session:${name}`,
          kind: 'session',
          label: name,
          detail: 'session',
          action: event({ type: 'SWITCH_SESSION', sessionName: name }),
        }),
      ),
    ...ctx.restorableSessions
      .filter((r) => r.name !== sessionName && !running.includes(r.name))
      .map(
        (r): AppPaletteEntry => ({
          id: `restore:${r.name}`,
          kind: 'session',
          label: r.name,
          detail: 'saved session',
          action: event({ type: 'RESTORE_SESSION', sessionName: r.name }),
        }),
      ),
  ];
}

type Places = Pick<PaletteEntries, 'tabs' | 'panes'>;

/** This session's tabs and panes, from live state, in the order the strip and the grid show. */
function placesHere(ctx: AppMachineContext): Places {
  const tabs: AppPaletteEntry[] = [];
  const panes: AppPaletteEntry[] = [];
  const cwdOf = new Map(
    ctx.sessions.flatMap((s) => s.panes).map((pane) => [pane.id, pane.cwd] as const),
  );
  for (const row of buildTreeRows(stripTabs(ctx.windows), ctx.panes, NO_TABS, ctx.paneGroups)) {
    if (row.kind === 'tab') {
      tabs.push({
        id: `tab:${row.window.id}`,
        kind: 'tab',
        label: row.window.name,
        detail: `tab ${row.position}`,
        action: event({ type: 'SELECT_TAB', windowId: row.window.id }),
      });
    } else {
      const { process, title } = paneRowLines(row.pane);
      panes.push({
        id: `pane:${row.pane.tmuxId}`,
        kind: 'pane',
        label: paneLabel(process, title),
        detail: `pane in ${row.window.name}`,
        keywords: cwdOf.get(row.pane.tmuxId),
        action: event({ type: 'SELECT_PANE', paneId: row.pane.tmuxId }),
      });
    }
  }
  return { tabs, panes };
}

/** One other session's tabs and panes, from the poll's listing: reached through a session switch. */
function placesIn(session: AppMachineContext['sessions'][number]): Places {
  const { sessionName } = session;
  const tabName = new Map(session.windows.map((w) => [w.id, w.name] as const));
  return {
    tabs: session.windows.map(
      (window): AppPaletteEntry => ({
        id: `tab:${window.id}`,
        kind: 'tab',
        label: window.name,
        detail: `tab in ${sessionName}`,
        action: event({ type: 'GO_TO', sessionName, windowId: window.id }),
      }),
    ),
    panes: session.panes.map(
      (pane): AppPaletteEntry => ({
        id: `pane:${pane.id}`,
        kind: 'pane',
        label: paneLabel(pane.command || 'shell', pane.title.trim()),
        detail: `pane in ${tabName.get(pane.windowId) ?? 'a tab'}, ${sessionName}`,
        keywords: pane.cwd,
        action: event({ type: 'GO_TO', sessionName, windowId: pane.windowId, paneId: pane.id }),
      }),
    ),
  };
}

export function paletteEntries(
  ctx: AppMachineContext,
  env: MenuEnv,
  options: AppMenuOptions = {},
): PaletteEntries {
  const places = [
    placesHere(ctx),
    ...ctx.sessions.filter((s) => s.sessionName !== ctx.sessionName).map(placesIn),
  ];
  return {
    actions: specEntries(appMenuSpec(ctx, env, options), { omit: OWN_ITEMS }),
    sessions: sessionEntries(ctx),
    tabs: places.flatMap((p) => p.tabs),
    panes: places.flatMap((p) => p.panes),
  };
}

/**
 * The row that makes a session of what was typed, when no session has that
 * name: null for text no name can be made of, a name already taken, and the
 * demo, which has one session.
 */
export function newSessionEntry(
  ctx: AppMachineContext,
  env: MenuEnv,
  typed: string,
): AppPaletteEntry | null {
  if (env.isDemo) return null;
  const name = sessionNameFrom(typed);
  if (!name) return null;
  const taken =
    name === ctx.sessionName ||
    ctx.sessions.some((s) => s.sessionName === name) ||
    ctx.restorableSessions.some((r) => r.name === name);
  if (taken) return null;
  return {
    id: 'session-new-named',
    kind: 'session',
    label: `New Session “${name}”`,
    detail: 'create it and switch',
    icon: 'new',
    action: event({ type: 'NEW_SESSION', name }),
  };
}
