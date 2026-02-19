/** Extract a display title from widget content lines */
export function getWidgetTitle(contentLines: string[]): string | undefined {
  // Check for __TITLE__:name protocol in any content line
  for (const line of contentLines) {
    const titleMatch = line.trim().match(/^__TITLE__:(.+)/);
    if (titleMatch) return titleMatch[1].trim();
  }

  const joined = contentLines.join('').trim();

  // Try HTTP URL — extract filename
  const urlMatch = joined.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    try {
      const pathname = new URL(urlMatch[0]).pathname;
      const filename = pathname.split('/').pop();
      if (filename) return decodeURIComponent(filename);
    } catch { /* ignore */ }
  }

  // Try data URI — show truncated prefix
  const dataMatch = joined.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/]{0,10}/);
  if (dataMatch) return dataMatch[0] + '...';

  return undefined;
}
