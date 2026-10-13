/** What a markdown pane is named after (`MarkdownView`). */

/**
 * The document's first level-1 heading, as plain text: what the pane is named
 * after. ATX (`# Title`) or setext (`Title` over `===`); a heading inside a
 * fenced code block is code, not the document's.
 */
export function firstHeading(markdown: string): string | null {
  let fence: string | null = null;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (opener) {
      if (fence === null) fence = opener[1][0];
      else if (opener[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const atx = /^\s{0,3}#\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (atx && atx[1].trim()) return plainText(atx[1]);
    if (line.trim() && /^\s{0,3}=+\s*$/.test(lines[i + 1] ?? '')) return plainText(line);
  }
  return null;
}

/** A heading's inline markup reduced to its words: `**x**`, `` `x` ``, `[x](u)`. */
function plainText(inline: string): string {
  return (
    inline
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Emphasis markers only where they wrap words: `_` inside a word is part
      // of it (`BROWSER_WIDGET_MD`, `snake_case`).
      .replace(/(^|[^\w])[*_~]+([^*_~]+?)[*_~]+(?=[^\w]|$)/g, '$1$2')
      .replace(/[*`~]/g, '')
      .trim()
  );
}
