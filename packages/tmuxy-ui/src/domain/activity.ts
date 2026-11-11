/**
 * The activity inbox: every pane on the server that has said something about
 * itself, across sessions, the one that wants the user most first.
 *
 * A pane's state is its own word (`@tmuxy-pane-state`, with what its program
 * said behind it in `@tmuxy-pane-status`), and tmux holds both for every
 * session. So the inbox is one `list-panes -a`: the session in view is not
 * special, and a pane in a session nobody has open is listed like any other.
 */

import { listEveryPane } from './commandHelpers';
import { isPaneId, isWindowId, type PaneId, type WindowId } from './ids';
import { PANE_STATE_TIER, readPaneState, type PaneStateName } from './paneState';
import { paneStateLabel } from './paneStatus';
import { APP_PANE_TITLE, PANE_OPTIONS, PANE_STATES, STASH_SESSION } from './tmuxyConstants.gen';

const SEP = '\t';

/** One row per pane, tab-joined, the text a user or a program chose last. */
const FORMAT = [
  '#{session_name}',
  '#{window_id}',
  '#{window_index}',
  '#{pane_id}',
  `#{${PANE_OPTIONS.state}}`,
  `#{${PANE_OPTIONS.status}}`,
  '#{pane_current_command}',
  `#{${PANE_OPTIONS.label}}`,
  APP_PANE_TITLE,
  '#{window_name}',
].join(SEP);

export const LIST_ACTIVITY_COMMAND = listEveryPane(FORMAT);

export interface ActivityRow {
  paneId: PaneId;
  windowId: WindowId;
  session: string;
  /** The tab's name and its place in the session's strip. */
  tab: string;
  tabIndex: number;
  state: PaneStateName;
  /** What the pane is called: its label, else its program's title, else the program. */
  name: string;
  /** The state in words, with what the program said behind it. */
  said: string;
}

/** Enough of a row to go to its pane. */
export type ActivityTarget = Pick<ActivityRow, 'paneId' | 'windowId' | 'session'>;

const KNOWN_STATES = new Set<string>(PANE_STATES);

/**
 * The panes that declared a state, most urgent first: `needs-input`, `error`,
 * `unread`, `working`, `idle`. Within a state they keep tmux's order, which
 * is by session and tab. A pane that never said anything is not listed, and
 * neither is a pane-group member parked out of view.
 */
export function parseActivity(listing: string): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const line of listing.split('\n')) {
    const [session, windowId, index, paneId, state, status, command, label, title, ...tab] =
      line.split(SEP);
    if (!session || session === STASH_SESSION) continue;
    if (!isWindowId(windowId) || !isPaneId(paneId) || !KNOWN_STATES.has(state)) continue;
    const known = readPaneState(state);
    rows.push({
      paneId,
      windowId,
      session,
      tab: tab.join(SEP),
      tabIndex: Number(index) || 0,
      state: known,
      name: label || title || command || paneId,
      said: paneStateLabel(known, { paneState: state, paneStatus: status || null }),
    });
  }
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => PANE_STATE_TIER[a.row.state] - PANE_STATE_TIER[b.row.state] || a.at - b.at)
    .map(({ row }) => row);
}

/** The rows whose session, tab, name or words contain `query`, ignoring case. */
export function filterActivity(rows: readonly ActivityRow[], query: string): ActivityRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [row.session, row.tab, row.name, row.said].some((text) => text.toLowerCase().includes(needle)),
  );
}

/**
 * The pane to go to when asked for whoever needs the user most: the first
 * that is waiting, failed or has a result, other than the pane in front.
 * A pane that is only working or idle is nobody to go to.
 */
export function mostUrgent(
  rows: readonly ActivityRow[],
  inFront: PaneId | null,
): ActivityRow | null {
  const wanting = rows.find(
    (row) => row.paneId !== inFront && PANE_STATE_TIER[row.state] <= PANE_STATE_TIER.unread,
  );
  return wanting ?? null;
}

/** Where a row is, as the inbox writes it: `session · tab`. */
export function activityPlace(row: ActivityRow): string {
  return [row.session, row.tab].filter(Boolean).join(' · ');
}
