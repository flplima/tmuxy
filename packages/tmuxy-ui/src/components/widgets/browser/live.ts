/**
 * A live browser pane: `tmuxy browser`, a real engine drawing the page into the
 * pane (packages/tmuxy-server/src/browser/pane.rs).
 *
 * The pane tags itself `@tmuxy-pane-widget browser-live` through the CLI, and
 * writes a short header on its top row, which the app covers with the address
 * bar. The header says which way history can go and whether the theme filter
 * is on; the address is the pane's title, because a URL is longer than a row.
 */

/** The pane tag a live browser sets on itself (`LIVE_WIDGET` in pane.rs). */
export const LIVE_BROWSER_WIDGET = 'browser-live';

/** What the top row starts with (`HEADER_PREFIX` in pane.rs). */
const HEADER = /^tmuxy:browser ([01])([01])([01])\s*$/;

export interface LiveBrowserHeader {
  canGoBack: boolean;
  canGoForward: boolean;
  colorFilter: boolean;
}

/** The header on a live browser's top row, or null when the row is not one. */
export function parseLiveHeader(row: string): LiveBrowserHeader | null {
  const match = HEADER.exec(row);
  if (!match) return null;
  return {
    canGoBack: match[1] === '1',
    canGoForward: match[2] === '1',
    colorFilter: match[3] === '1',
  };
}

/**
 * A verb line typed into the pane, the way an agent drives it
 * (`tmuxy pane send ':goto …' Enter`). One line: a newline inside would end
 * the verb early and run the rest as keys to the page.
 */
export function verbLine(verb: string): string {
  return `:${verb.replace(/[\r\n]+/g, ' ')}\n`;
}
