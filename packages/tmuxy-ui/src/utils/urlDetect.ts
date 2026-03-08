/**
 * Auto-detect URLs in terminal line text.
 * Returns ranges of detected URLs for rendering as clickable links.
 */

export interface DetectedUrl {
  start: number;
  end: number; // exclusive
  url: string;
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g;

/**
 * Find all URLs in a string, returning their character ranges.
 * Strips trailing punctuation that's likely sentence-ending, not part of the URL.
 */
export function detectUrls(text: string): DetectedUrl[] {
  const results: DetectedUrl[] = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0];
    // Strip trailing punctuation (period, comma, etc.)
    while (url.length > 1 && /[.,;:!?)}\]]$/.test(url)) {
      url = url.slice(0, -1);
    }
    results.push({ start: m.index, end: m.index + url.length, url });
  }
  return results;
}
