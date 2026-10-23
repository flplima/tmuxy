/**
 * `read_preview` for the in-browser guests, which have no server to read the
 * guest's files: tmux does it, under the same rules `tmuxy_core::preview`
 * applies. tmux names the file a pane may preview (`@tmuxy-pane-widget`,
 * `@tmuxy-pane-preview`, written by `tmuxy-widget-preview`), and a run-shell
 * reads it — the document, or a resource it links that stays in its folder
 * (`previewResourcePath`). Symlinks are not resolved as the server resolves
 * them: the guest is the visitor's own machine, holding nothing but itself.
 *
 * A markdown document renders in the app. A page needs a frame loading it
 * from a URL served under its own sandboxing policy, which only a server can
 * stage, so a page preview is refused with that reason rather than left
 * reading forever.
 */
import type { CommandFailure } from '../../../../domain/wire';
import { quote } from '../../../../domain/commands';
import {
  previewKind,
  previewResourcePath,
  type PreviewDocument,
  type PreviewResource,
} from '../../../../domain/preview';
import { isPaneId } from '../../../../domain/ids';

/** Run a tmux command and resolve with what it printed (`GuestEngine.query`). */
type Query = (command: string) => Promise<string>;

/** The types a page may load, as a preview serves them. */
const MIME: Record<string, string> = {
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

function refused(error: string): CommandFailure {
  return { error, kind: 'forbidden' };
}

/** A shell command as one run-shell argument; run-shell expands `#` first. */
function runShell(command: string): string {
  return `run-shell ${quote(command.replace(/#/g, '##'))}`;
}

export async function readGuestPreview(
  query: Query,
  paneId: string,
  path: string | undefined,
): Promise<PreviewDocument | PreviewResource> {
  if (!isPaneId(paneId)) throw refused('this pane is not showing a preview');
  const answer = await query(
    ['@tmuxy-pane-widget', '@tmuxy-pane-preview', '@tmuxy-pane-preview-net']
      .map((option) => `display-message -p -t ${paneId} '#{${option}}'`)
      .join(' ; '),
  );
  const [widget = '', document = '', net = ''] = answer.split('\n').map((line) => line.trim());
  if (widget !== 'preview' || !document.startsWith('/')) {
    throw refused('this pane is not showing a preview');
  }

  if (path === undefined) {
    const kind = previewKind(document);
    if (!kind) throw refused('a preview shows an .html or .md file, nothing else');
    if (kind === 'html') {
      throw refused("a page preview needs tmuxy's server, which this in-browser demo runs without");
    }
    return {
      kind,
      name: document.slice(document.lastIndexOf('/') + 1),
      text: await query(runShell(`cat -- ${quote(document)}`)),
      net: net === '1',
    };
  }

  const relative = previewResourcePath(path);
  if (!relative) throw refused('not a file this preview may read');
  const file = document.slice(0, document.lastIndexOf('/') + 1) + relative;
  const data = await query(runShell(`base64 -- ${quote(file)}`));
  return {
    mime:
      MIME[relative.slice(relative.lastIndexOf('.') + 1).toLowerCase()] ??
      'application/octet-stream',
    data: data.replace(/\s+/g, ''),
  };
}
