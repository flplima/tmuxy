/**
 * What the status line says in each mode: the hints, and the mode's name.
 *
 * Every line is written to fit 80 columns — the narrowest pty tmuxy is
 * designed around — with 1ch of padding either side, and the test beside
 * this file holds each one to that. A hint is `[key] label`; hints are joined
 * by ` · `. No line says how to leave a mode: `esc` leaves every one.
 *
 * Normal mode shows the three chords used constantly; a mode replaces the
 * whole left side with its name and a handful of its keys. The rest of a
 * table is in the keys view (`prefix ?`).
 */

export interface Hint {
  readonly key: string;
  readonly label: string;
}

/** The modes the status line names, by the key table they are. */
export const MODE_HINTS: Readonly<Record<string, readonly Hint[]>> = {
  prefix: [
    { key: '-|', label: 'split' },
    { key: 'c', label: 'new tab' },
    { key: 'p', label: 'pane' },
    { key: 't', label: 'tab' },
    { key: 's/S', label: 'sidebars' },
  ],
  copy: [
    { key: 'hjkl', label: 'move' },
    { key: 'v', label: 'select' },
    { key: 'y', label: 'copy' },
    { key: '/', label: 'search' },
  ],
  pane: [
    { key: 'hjkl', label: 'focus' },
    { key: '-|', label: 'split' },
    { key: 'x', label: 'close' },
    { key: 'z', label: 'zoom' },
    { key: 's', label: 'stack' },
  ],
  tab: [
    { key: 'hl', label: 'prev/next' },
    { key: 'c', label: 'new' },
    { key: ',', label: 'rename' },
    { key: 'x', label: 'close' },
    { key: '1-9', label: 'go' },
  ],
};

/**
 * Normal mode: the prefix, pane navigation and tab selection. The first two
 * name whatever key the config binds (`navKey` is null when nothing bound to
 * pane navigation spells one word); ctrl+1-9 is the client's own.
 */
export function normalHints(prefixLabel: string, navKey: string | null): Hint[] {
  return [
    { key: prefixLabel, label: 'prefix' },
    ...(navKey ? [{ key: navKey, label: 'panes' }] : []),
    { key: 'ctrl+1-9', label: 'tabs' },
  ];
}

export const HINT_SEPARATOR = ' · ';

/** A line as the monospace row lays it out: the mode's name, then its hints. */
export function hintLineText(hints: readonly Hint[], mode?: string): string {
  const parts = hints.map((h) => `[${h.key}] ${h.label}`);
  return (mode ? [mode, ...parts] : parts).join(HINT_SEPARATOR);
}
