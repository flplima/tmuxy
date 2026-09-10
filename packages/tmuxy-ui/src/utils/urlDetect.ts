/**
 * Auto-detect URLs in terminal line text.
 * Returns ranges of detected URLs for rendering as clickable links.
 */

export interface DetectedUrl {
  start: number;
  end: number; // exclusive
  url: string;
}

/**
 * What a URL is allowed to contain: every ASCII character RFC 3986 permits in
 * a URI — unreserved, the gen- and sub-delimiters, and `%` for escapes — plus
 * Unicode letters, digits and combining marks, so an internationalised
 * address still matches.
 *
 * Defined by what it ADMITS, not by what it excludes. A terminal UI butts its
 * text against separators with no space in between, and a class written the
 * other way round swallowed every one of them — `…/bar│Files:12│Status:ok`,
 * `…/path→next`, `…/a&b=1|next` each came back as a single URL covering most
 * of the line, which is what put a link's highlight over unrelated text.
 */
const URL_CHAR = String.raw`[\p{L}\p{N}\p{M}\-._~:/?#\[\]@!$&'()*+,;=%]`;
const URL_RE = new RegExp(String.raw`https?://${URL_CHAR}+`, 'gu');

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
    while (url.length > 1 && /[.,;:!?)\]]$/.test(url)) {
      url = url.slice(0, -1);
    }
    results.push({ start: m.index, end: m.index + url.length, url });
  }
  return results;
}
