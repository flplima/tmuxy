/**
 * The `preview` widget's file rules, as the client applies them.
 *
 * The server decides what a preview may read (`tmuxy_core::preview`): the
 * document the pane was opened on, and resources linked from it that stay in
 * its folder, pass no hidden name and are a type a page loads. The client
 * applies the same rules before it asks, for two reasons: a reference the
 * server would refuse is not worth a round trip, and the server takes a
 * normalised relative path (`img/a.png`, never `./x/../img/a.png`) — turning
 * what a document wrote into one is the client's job. The demo engine reads
 * its in-memory files through these rules too.
 */

export type PreviewKind = 'html' | 'markdown';

/** What a document may link, by extension. Mirrors `RESOURCE_EXTENSIONS`. */
const RESOURCE_EXTENSIONS = new Set([
  'css',
  'js',
  'mjs',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'bmp',
  'woff',
  'woff2',
  'ttf',
  'otf',
]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The kind of document a path names, or null for anything a preview does not show. */
export function previewKind(path: string): PreviewKind | null {
  const ext = extensionOf(path);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return null;
}

/** Whether a document-relative path is a type a page may load. */
export function isPreviewResource(relative: string): boolean {
  return RESOURCE_EXTENSIONS.has(extensionOf(relative));
}

/**
 * A reference `ref`, written in the file at document-relative `from` ('' for
 * the document itself), as the document-relative path `read_preview` takes —
 * or null when it is not one a preview reads: a URL with a scheme or a host,
 * a fragment, an absolute path, one that climbs out of the document's folder
 * or passes through a hidden name, or a type a page does not load.
 */
export function previewResourcePath(ref: string, from = ''): string | null {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const bare = trimmed.replace(/[?#].*$/, '');
  if (!bare || bare.startsWith('/') || bare.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const segments = from.split('/').slice(0, -1).filter(Boolean);
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    if (segment.startsWith('.')) return null;
    segments.push(segment);
  }
  const path = segments.join('/');
  return path && isPreviewResource(path) ? path : null;
}

/** `read_preview` with no path: the document. */
export interface PreviewDocument {
  kind: PreviewKind;
  /** The file's name, for the pane's title until the document gives one. */
  name: string;
  text: string;
  /** Opened with `--net`: the page may load from the network. */
  net: boolean;
}

/** `read_preview` with a path: a resource's type and its bytes in base64. */
export interface PreviewResource {
  mime: string;
  data: string;
}

/** The widget's content lines, as `tmuxy-widget-preview` prints them. */
export interface PreviewLines {
  /** The file's name, before the document has been read. */
  file: string;
  /** Changes whenever the file does: the cue to read it again. */
  rev: string;
  /** `--no-theme`: the page keeps its own colours. */
  themed: boolean;
}

export function parsePreviewLines(lines: string[]): PreviewLines {
  let file = '';
  let rev = '';
  let themed = true;
  for (const line of lines) {
    if (line === '__NO_THEME__') themed = false;
    else if (line.startsWith('__FILE__:')) file = line.slice('__FILE__:'.length);
    else {
      // The rev line is rewritten in place with `\r`, so a line can carry an
      // earlier rev's leftovers before the current one.
      const at = line.lastIndexOf('__REV__:');
      if (at >= 0) rev = line.slice(at + '__REV__:'.length).trim();
    }
  }
  return { file, rev, themed };
}

/** A markdown document split into its YAML front matter and the rest. */
export interface MarkdownParts {
  /** The YAML between the fences, or null when the document opens without any. */
  frontMatter: string | null;
  body: string;
}

/**
 * A `---` line opening the document, the YAML, then a `---` or `...` line
 * closing it — the front matter Jekyll, Hugo and GitHub read. CommonMark has no
 * such thing: it draws the opening fence as a rule and the closing one as the
 * underline of a heading made of the YAML.
 */
const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontMatter(text: string): MarkdownParts {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { frontMatter: null, body: text };
  return { frontMatter: match[1] ?? '', body: text.slice(match[0].length) };
}
