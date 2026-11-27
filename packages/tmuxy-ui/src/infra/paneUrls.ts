/**
 * A URL a program in a pane asked to open (`$BROWSER`, the `browser` script),
 * delivered by the host as `open-url` to the one client used last.
 *
 * A pane runs whatever it likes, so it must not be able to open tabs on its
 * own whenever it likes. The URL opens directly only when the person used
 * the app (a click or a key) in the last ACTIVATION_WINDOW_MS — Chrome's
 * transient user activation lasts about that long, so a browser that would
 * refuse the tab gets the notice instead — and only once per interaction.
 * Otherwise, and whenever the browser would refuse the tab, the notice shows
 * the URL with an Open button the person clicks. Past RATE_MAX requests in
 * RATE_WINDOW_MS the rest are dropped, notice and all. Only links the clicked
 * ones may be (`isOpenableUrl`) are ever considered.
 */

import { isOpenableUrl, openExternalUrl } from './openUrl';

/** How recent an interaction lets a pane's URL open with no notice. */
export const ACTIVATION_WINDOW_MS = 5000;
/** The most URLs a pane gets opened or noticed in RATE_WINDOW_MS. */
export const RATE_MAX = 5;
export const RATE_WINDOW_MS = 10_000;

export type PaneUrlDecision = 'open' | 'notice' | 'drop';

export class PaneUrlGate {
  private lastActivation = Number.NEGATIVE_INFINITY;
  private recent: number[] = [];

  /** The person clicked or typed in the app at `at`. */
  noteActivation(at: number): void {
    this.lastActivation = at;
  }

  /**
   * What to do with `url`, asked at `now`. An `open` uses the interaction
   * up: a second URL from the same click gets the notice.
   */
  decide(url: string, now: number): PaneUrlDecision {
    if (!isOpenableUrl(url)) return 'drop';
    this.recent = this.recent.filter((at) => now - at < RATE_WINDOW_MS);
    if (this.recent.length >= RATE_MAX) return 'drop';
    this.recent.push(now);
    if (now - this.lastActivation > ACTIVATION_WINDOW_MS) return 'notice';
    this.lastActivation = Number.NEGATIVE_INFINITY;
    return 'open';
  }
}

/** What the notice for a URL says; its Open button opens `openUrl`. */
export interface PaneUrlNotice {
  readonly text: string;
  readonly kind: 'info';
  readonly openUrl: string;
}

export const paneUrlNotice = (url: string): PaneUrlNotice => ({
  text: `A program asked to open ${url}`,
  kind: 'info',
  openUrl: url,
});

const gate = new PaneUrlGate();

/**
 * Count clicks and keys anywhere in the page as the person using the app,
 * from now until the returned function is called.
 */
export function trackUserActivation(target: Window = window): () => void {
  const note = () => gate.noteActivation(Date.now());
  const options = { capture: true, passive: true } as const;
  target.addEventListener('pointerdown', note, options);
  target.addEventListener('keydown', note, options);
  return () => {
    target.removeEventListener('pointerdown', note, options);
    target.removeEventListener('keydown', note, options);
  };
}

/** Open `url` for a pane, or tell the person about it (`say`), or drop it. */
export function openPaneUrl(url: string, say: (notice: PaneUrlNotice) => void): void {
  const decision = gate.decide(url, Date.now());
  if (decision === 'drop') return;
  if (decision === 'open' && openExternalUrl(url)) return;
  say(paneUrlNotice(url.trim()));
}
