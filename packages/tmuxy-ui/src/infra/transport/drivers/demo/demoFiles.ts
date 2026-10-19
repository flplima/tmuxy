/**
 * One machine's files, across the demo's panes.
 *
 * Each pane's shell runs in a lifo sandbox of its own — its own shell state,
 * its own `tmuxy` command bound to its own pane — but on a real machine every
 * pane sees the same disk: a file written in one is there in the next, and a
 * preview in one pane follows a file being edited in another. So every
 * sandbox's writes are copied into the others the moment they happen (lifo's
 * VFS is synchronous and so are its watchers), and a pane opened later starts
 * from the files the others hold. A copy that would change nothing is skipped,
 * which is also what ends the echo of a copy's own change event.
 */

import type { VFS, VFSWatchEvent } from '@lifo-sh/core';

/** Where the demo's shells write: the home directory and the scratch space. */
const SHARED_ROOTS = ['/home', '/tmp'];

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

/** Copy `path` from one VFS to another unless it is already the same there. */
function copyFile(from: VFS, to: VFS, path: string): void {
  const data = from.readFile(path);
  if (to.exists(path) && to.stat(path).type === 'file' && sameBytes(to.readFile(path), data)) {
    return;
  }
  to.mkdir(folderOf(path), { recursive: true });
  to.writeFile(path, data);
}

/** Every file under `root` in `vfs`. */
function filesUnder(vfs: VFS, root: string): string[] {
  if (!vfs.exists(root)) return [];
  const files: string[] = [];
  for (const entry of vfs.readdirStat(root)) {
    const path = `${root === '/' ? '' : root}/${entry.name}`;
    if (entry.type === 'directory') files.push(...filesUnder(vfs, path));
    else if (entry.type === 'file') files.push(path);
  }
  return files;
}

export class DemoFiles {
  private readonly disks: VFS[] = [];

  /** A new pane's sandbox: given the files so far, then kept in step. */
  join(vfs: VFS): void {
    const first = this.disks[0];
    if (first) {
      for (const root of SHARED_ROOTS) {
        for (const path of filesUnder(first, root)) copyFile(first, vfs, path);
      }
    }
    this.disks.push(vfs);
    vfs.watch((event) => this.mirror(vfs, event));
  }

  private mirror(from: VFS, event: VFSWatchEvent): void {
    if (!SHARED_ROOTS.some((root) => event.path.startsWith(`${root}/`))) return;
    for (const to of this.disks) {
      if (to === from) continue;
      try {
        if (event.type === 'delete') {
          if (to.exists(event.path)) {
            if (event.fileType === 'directory') to.rmdirRecursive(event.path);
            else to.unlink(event.path);
          }
        } else if (event.type === 'rename' && event.oldPath) {
          if (to.exists(event.oldPath)) to.rename(event.oldPath, event.path);
          else if (from.exists(event.path) && event.fileType === 'file')
            copyFile(from, to, event.path);
        } else if (event.fileType === 'directory') {
          to.mkdir(event.path, { recursive: true });
        } else if (from.exists(event.path)) {
          copyFile(from, to, event.path);
        }
      } catch {
        // A pane whose disk cannot take the change keeps what it has.
      }
    }
  }
}
