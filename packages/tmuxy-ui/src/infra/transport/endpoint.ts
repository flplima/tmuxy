/**
 * Where the web server's endpoints are and which session they serve. Free of
 * the transport around it, so a page that only needs the URLs — the e-ink one
 * (`src/kindle/`) — does not bundle the stream machinery to get them.
 */

/**
 * Get the session name from URL query parameters.
 * Falls back to 'tmuxy' if not specified.
 */
export function getSessionFromUrl(): string {
  if (typeof window === 'undefined') return 'tmuxy';
  const params = new URLSearchParams(window.location.search);
  return params.get('session') || 'tmuxy';
}

export function buildEndpointUrl(path: string, session?: string): string {
  const protocol = window.location.protocol;
  const host = window.location.host || 'localhost:3853';
  const query = session !== undefined ? `?session=${encodeURIComponent(session)}` : '';
  return `${protocol}//${host}${path}${query}`;
}
