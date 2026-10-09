/**
 * Where a markdown document's links and images may point.
 *
 * SEC-20. The markdown is fetched and rendered in the APP's origin, so a URL
 * the document wrote is resolved by the browser as if the app had written it:
 * a relative `![](diagram.png)` against the app root instead of the file it was
 * written next to, and an absolute `![](/api/images/0/1)` or `[x](/events)`
 * straight at the app's own API through the reader's session.
 */

/** The schemes a document may pull a subresource from. */
const ALLOWED_PROTOCOLS = ['http:', 'https:', 'data:', 'blob:', 'tmuxyfile:'];

/**
 * The only path on the app's own origin a document may reach: the route that
 * serves files, which is how a local document's own images arrive. Every
 * other same-origin path is the app itself — its API, its event stream — and
 * a document has no business aiming the reader's browser at it.
 */
const SAME_ORIGIN_FILE_ROUTE = '/api/browse/';

/**
 * Resolve a URL a markdown document wrote against the DOCUMENT, not the app.
 *
 * `documentOrigin` is the app's origin as the browser sees it. `undefined` for
 * anything that survives resolution as a scheme we will not load (`javascript:`
 * and whatever else a document might invent) or as an app path that is not a
 * file route.
 */
export function resolveAgainstDocument(
  raw: string | undefined,
  base: string,
  documentOrigin: string,
): string | undefined {
  if (!raw) return undefined;
  try {
    const resolved = new URL(raw, new URL(base, documentOrigin));
    if (!ALLOWED_PROTOCOLS.includes(resolved.protocol)) return undefined;
    if (resolved.origin === new URL(documentOrigin).origin && !isFileRoute(resolved.pathname)) {
      return undefined;
    }
    return resolved.href;
  } catch {
    return undefined;
  }
}

function isFileRoute(pathname: string): boolean {
  return pathname.startsWith(SAME_ORIGIN_FILE_ROUTE);
}
