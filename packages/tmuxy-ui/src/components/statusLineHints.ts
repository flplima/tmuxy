/**
 * What the status line says in each mode: the hints, and the mode's name.
 *
 * Every line is written to fit 80 columns — the narrowest pty tmuxy is
 * designed around — with 1ch of padding either side, and the test beside
 * this file holds each one to that. A hint is `[key] label`; hints are joined
 * by ` · `. No line says how to leave a mode: `esc` leaves every one.
 *
 * Normal mode shows the three chords used constantly; a mode replaces the
 * whole left side with its name and a handful of its keys, read from the
 * bindings so the line names the keys the config actually binds. The rest
 * of a table is in the keys view (`prefix ?`).
 */

import type { KeyBindings } from '../domain/wire';
import { renameWindowPrompt, TmuxOp, type PaneDirection } from '../domain/commands';
import { script } from '../domain/commandHelpers';
import { formatKey, tableKeysFor } from '../domain/keyLabels';
import {
  CLIENT_KEYS,
  splitTableSwitch,
  TAB_POSITION_CHORDS,
  type ClientKey,
} from '../domain/keyTables';
import { tabPosition } from '../domain/store/parseCommand';

export interface Hint {
  readonly key: string;
  readonly label: string;
}

/**
 * What a hint's key is: the first key of its table bound to each op (all of
 * them bound, or the hint is left out — `hjl` would lie about `k`), spelled
 * one after the other (`hjkl`, `-|`), or `joined` between them (`s/S`).
 */
interface HintSpec {
  readonly label: string;
  readonly keys: (keybindings: KeyBindings, table: string) => Array<string | undefined>;
  readonly joined?: string;
}

const bound =
  (...ops: TmuxOp[]): HintSpec['keys'] =>
  (keybindings, table) =>
    ops.map((op) => tableKeysFor(keybindings, table, op)[0]);

/** The table's own keys for client keys (`CLIENT_KEYS`). */
const client =
  (...keys: ClientKey[]): HintSpec['keys'] =>
  (_, table) =>
    keys.map(
      (key) => Object.entries(CLIENT_KEYS[table] ?? {}).find(([, bound]) => bound === key)?.[0],
    );

/** The keys that enter a sticky table. */
const entering =
  (target: string): HintSpec['keys'] =>
  (keybindings) => [
    keybindings.prefix_bindings.find((b) => {
      const { command, table } = splitTableSwitch(b.command);
      return table === target && command === '';
    })?.key,
  ];

/** The digits of a table bound to a tab's position, as a range (`1-9`). */
const positions: HintSpec['keys'] = (keybindings, table) => {
  const digits = (keybindings.tables[table] ?? [])
    .filter((b) => tabPosition(b.command) !== null)
    .map((b) => b.key)
    .sort();
  return digits.length > 1 ? [`${digits[0]}-${digits[digits.length - 1]}`] : digits;
};

const navigate = (direction: PaneDirection) => TmuxOp.Navigate({ direction, script: true });
const NAV_DIRECTIONS: readonly PaneDirection[] = ['L', 'D', 'U', 'R'];
const SPLITS = [
  TmuxOp.Split({ direction: 'horizontal' }),
  TmuxOp.Split({ direction: 'vertical' }),
] as const;

/** The modes the status line names, by the key table they are. */
const MODE_HINTS: Readonly<Record<string, readonly HintSpec[]>> = {
  prefix: [
    { keys: bound(...SPLITS), label: 'split' },
    { keys: bound(TmuxOp.NewWindow()), label: 'new tab' },
    { keys: entering('pane'), label: 'pane' },
    { keys: entering('tab'), label: 'tab' },
    { keys: client('left-sidebar', 'right-sidebar'), label: 'sidebars', joined: '/' },
  ],
  pane: [
    { keys: bound(...NAV_DIRECTIONS.map(navigate)), label: 'focus' },
    { keys: bound(...SPLITS), label: 'split' },
    { keys: bound(TmuxOp.KillPane({ paneId: null })), label: 'close' },
    { keys: bound(TmuxOp.ZoomToggle({ paneId: null })), label: 'zoom' },
    {
      keys: bound(TmuxOp.RawCommand({ command: script('stack', 'new', '#{pane_id}') })),
      label: 'stack',
    },
  ],
  tab: [
    {
      keys: bound(
        TmuxOp.SelectWindow({ target: 'previous' }),
        TmuxOp.SelectWindow({ target: 'next' }),
      ),
      label: 'prev/next',
    },
    { keys: bound(TmuxOp.NewWindow()), label: 'new' },
    { keys: bound(renameWindowPrompt()), label: 'rename' },
    { keys: bound(TmuxOp.KillWindow({ windowId: null })), label: 'close' },
    { keys: positions, label: 'go' },
  ],
};

/** Copy mode's keys are the client's own vi engine's (domain/copyModeKeys.ts), not a tmux table. */
const COPY_HINTS: readonly Hint[] = [
  { key: 'hjkl', label: 'move' },
  { key: 'v', label: 'select' },
  { key: 'y', label: 'copy' },
  { key: '/', label: 'search' },
];

/** The hints of a mode, keyed by what its table binds; none for a table the line knows nothing about. */
export function modeHints(keybindings: KeyBindings | null, mode: string): Hint[] {
  if (mode === 'copy') return [...COPY_HINTS];
  const specs = MODE_HINTS[mode];
  if (!specs || !keybindings) return [];
  return specs.flatMap(({ keys, label, joined = '' }) => {
    const found = keys(keybindings, mode);
    if (found.length === 0 || found.some((key) => key === undefined)) return [];
    return [{ key: found.map((key) => formatKey(key!)).join(joined), label }];
  });
}

/**
 * The label for directional pane nav without the prefix — `ctrl+hjkl` for the
 * default bindings — or null when the four directions do not share one
 * modifier on h, j, k and l (anything else is left to the keys view).
 */
function navHintKey(keybindings: KeyBindings): string | null {
  const keys = NAV_DIRECTIONS.map((d) => tableKeysFor(keybindings, 'root', navigate(d)));
  for (const modifier of ['C', 'M']) {
    if ('hjkl'.split('').every((letter, i) => keys[i].includes(`${modifier}-${letter}`))) {
      return `${formatKey(`${modifier}-x`).slice(0, -1)}hjkl`;
    }
  }
  return null;
}

/**
 * Normal mode: the prefix, pane navigation and tab selection, named by
 * whatever keys the config binds (a user's own config may move them); the
 * tab chord is the client's own.
 */
export function normalHints(keybindings: KeyBindings): Hint[] {
  const navKey = navHintKey(keybindings);
  return [
    { key: formatKey(keybindings.prefix_key), label: 'prefix' },
    ...(navKey ? [{ key: navKey, label: 'panes' }] : []),
    { key: TAB_POSITION_CHORDS, label: 'tabs' },
  ];
}

export const HINT_SEPARATOR = ' · ';

/** A line as the monospace row lays it out: the mode's name, then its hints. */
export function hintLineText(hints: readonly Hint[], mode?: string): string {
  const parts = hints.map((h) => `[${h.key}] ${h.label}`);
  return (mode ? [mode, ...parts] : parts).join(HINT_SEPARATOR);
}
