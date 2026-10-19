/**
 * The demo engine's `preview` widget: `tmuxy open` over the shell's in-memory
 * files, and `read_preview` under the server's rules (`domain/preview.ts`).
 */

import type { CommandFailure } from '../../../../domain/wire';
import {
  previewKind,
  previewResourcePath,
  type PreviewDocument,
  type PreviewResource,
} from '../../../../domain/preview';

/** A pane's preview: the one document it may read. */
export interface DemoPreview {
  path: string;
  net: boolean;
}

const MIME_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
};

function mimeType(path: string): string {
  return MIME_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'text/plain';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function refuse(error: string): CommandFailure {
  return { error, kind: 'forbidden' };
}

/** What `DemoPreviews` needs of the engine. */
export interface DemoPreviewHost {
  shellOf(paneId: string): { readFileBytes(path: string): Promise<Uint8Array> } | undefined;
  /** The pane's `@tmuxy-pane-widget`. */
  widgetOf(paneId: string): string | undefined;
  writeWidget(paneId: string, widget: string, lines: string[]): void;
  clearWidget(paneId: string): void;
}

/**
 * The panes running `tmuxy open`: each one's `@tmuxy-pane-preview` (and
 * `-net`), held out of band like the widget tag, and `read_preview` over it.
 */
export class DemoPreviews {
  private readonly previews = new Map<string, DemoPreview>();

  constructor(private readonly host: DemoPreviewHost) {}

  /** Authorise the pane's preview of `path`, then show the widget. */
  open(paneId: string, path: string, net: boolean, lines: string[]): void {
    this.previews.set(paneId, { path, net });
    this.host.writeWidget(paneId, 'preview', lines);
  }

  /** The preview is gone: its authorisation and its widget with it. */
  close(paneId: string): void {
    this.previews.delete(paneId);
    this.host.clearWidget(paneId);
  }

  /** `read_preview`: the document the pane was opened on, or a resource beside it. */
  read(paneId: string, path?: string): Promise<PreviewDocument | PreviewResource> {
    const shell = this.host.shellOf(paneId);
    const preview =
      shell && this.host.widgetOf(paneId) === 'preview' ? this.previews.get(paneId) : undefined;
    return readDemoPreview(preview, (p) => shell!.readFileBytes(p), path);
  }
}

/** `read_preview` for a pane whose preview is `preview`, read through `readFile`. */
async function readDemoPreview(
  preview: DemoPreview | undefined,
  readFile: (path: string) => Promise<Uint8Array>,
  path?: string,
): Promise<PreviewDocument | PreviewResource> {
  if (!preview) throw refuse('this pane is not showing a preview');
  if (path === undefined) {
    const kind = previewKind(preview.path);
    if (!kind) throw refuse('a preview shows an .html or .md file, nothing else');
    return {
      kind,
      name: preview.path.slice(preview.path.lastIndexOf('/') + 1),
      text: new TextDecoder().decode(await readFile(preview.path)),
      net: preview.net,
    };
  }
  if (previewResourcePath(path) !== path) throw refuse(`${path}: not a resource a page may read`);
  const folder = preview.path.slice(0, preview.path.lastIndexOf('/'));
  return { mime: mimeType(path), data: bytesToBase64(await readFile(`${folder}/${path}`)) };
}

/** `tmuxy open [--net] [--no-theme] <file>` (or `tmuxy widget preview …`), or null for any other `tmuxy` command. */
export function previewArgs(
  args: string[],
): { file: string; net: boolean; themed: boolean } | null {
  const rest =
    args[0] === 'open'
      ? args.slice(1)
      : args[0] === 'widget' && args[1] === 'preview'
        ? args.slice(2)
        : null;
  if (!rest) return null;
  let net = false;
  let themed = true;
  const files: string[] = [];
  for (const arg of rest) {
    if (arg === '--net') net = true;
    else if (arg === '--no-theme') themed = false;
    else files.push(arg);
  }
  return { file: files[0] ?? '', net, themed };
}
