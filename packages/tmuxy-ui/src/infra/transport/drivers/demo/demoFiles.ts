/**
 * One machine's files, across the demo's panes: a plain map of paths to
 * bytes that every pane's shell reads and writes, so a file written in one
 * pane is there in the next and a preview in one follows an edit in another.
 */

/** Where every demo shell starts. */
export const DEMO_HOME = '/home/demo';

/** `path` with `.` and `..` resolved, relative to `cwd` when not absolute. */
export function resolvePath(cwd: string, path: string): string {
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export class DemoFiles {
  private readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set(['/', '/home', DEMO_HOME, '/tmp']);

  /** The file's bytes, or null when there is no such file. */
  read(path: string): Uint8Array | null {
    return this.files.get(path) ?? null;
  }

  /** Write the file; false when its folder does not exist, as on a real disk. */
  write(path: string, text: string): boolean {
    if (!this.folders.has(folderOf(path)) || this.folders.has(path)) return false;
    this.files.set(path, new TextEncoder().encode(text));
    return true;
  }

  /** `mkdir -p`: the folder and every one above it. */
  mkdir(path: string): void {
    for (let at = path; at !== '/'; at = folderOf(at)) this.folders.add(at);
  }
}
