/**
 * Shows the raw tmux TUI behind a v86 story: a second, ordinary tmux client
 * on the guest's VGA text console (/dev/tty1), as the machine reads it back
 * (`V86Engine.watchScreen`). No tmuxy code is in that path, so it is the
 * reference to compare the React rendering against. The machine runs in a
 * worker, where v86 has no DOM to paint and keeps the console as text: what
 * crosses, and is drawn here, is its characters and its cursor. tmux's
 * colours (the status line, the active border) and blinking do not.
 *
 * The client is read-only (`-r`) and excluded from window sizing
 * (`-f ignore-size`), so it never steals input or resizes the window the
 * tmuxy control client sized. The guest VGA console is a fixed 80x25
 * terminal; the tmux window the tmuxy client drives is smaller
 * (TmuxViewFrame.tsx), which tmux draws top-left and leaves the rest of the
 * console blank — the side-mode CSS crops the screen to that window
 * (see tmuxView.css). A snapshot reset rewinds the guest and drops the client,
 * so it is re-attached on every engine `ready`.
 *
 * Alignment: the screen element is styled onto tmuxy's cell grid (`--cell-w`,
 * `--line-height-terminal`), so tmux cell (r, c) and tmuxy cell (r, c) have
 * identical geometry. In overlay mode the host is pinned to the tmuxy grid's
 * origin: tmux row 0 is the top pane-border line, which under
 * `pane-border-status top` is the header row of the topmost pane, and column 0
 * is half a cell inside the leftmost pane box (boxes extend half a cell into
 * the separator column on each side).
 */

import { getSharedEngine, type V86Engine } from '../infra/transport/drivers/v86/V86Engine';
import type { VgaScreen } from '../infra/transport/drivers/v86/machine';

const TTY = '/dev/tty1';
// The tty is opened READ-WRITE as stdin (`<>`): the client hands that fd to the
// server, which draws through it — an O_RDONLY `<` stdin attaches fine but
// paints nothing.
const ATTACH_VGA = `run-shell -b 'TERM=linux exec /usr/bin/tmux attach -r -f ignore-size -t m <>${TTY} >&0 2>&1'`;
const DETACH_VGA = `detach-client -t ${TTY}`;
const REALIGN_MS = 500;

export interface VgaMirrorOptions {
  /** Pin the host over this element's tmuxy pane grid (overlay mode). */
  alignTo?: HTMLElement;
}

export class VgaMirror {
  private readonly engine: V86Engine = getSharedEngine();
  private readonly screen = createScreen();
  private host: HTMLElement | null = null;
  private alignTo: HTMLElement | null = null;
  private offReady: (() => void) | null = null;
  private stopWatching: (() => void) | null = null;
  private realignTimer: ReturnType<typeof setInterval> | null = null;

  mount(host: HTMLElement, options: VgaMirrorOptions = {}): void {
    this.host = host;
    this.alignTo = options.alignTo ?? null;
    host.appendChild(this.screen);
    this.stopWatching = this.engine.watchScreen((screen) => paint(this.screen, screen));
    this.offReady = this.engine.onReady(() => this.attach());
    if (this.engine.isBooted()) this.attach();
    if (this.alignTo) {
      this.realign();
      this.realignTimer = setInterval(() => this.realign(), REALIGN_MS);
    }
  }

  unmount(): void {
    this.offReady?.();
    this.offReady = null;
    this.stopWatching?.();
    this.stopWatching = null;
    if (this.realignTimer) clearInterval(this.realignTimer);
    this.realignTimer = null;
    if (this.engine.isBooted()) this.engine.send(DETACH_VGA);
    this.screen.remove();
    this.host = null;
    this.alignTo = null;
  }

  private attach(): void {
    this.engine.send(ATTACH_VGA);
  }

  /** Overlay: put tmux cell (0,0) on tmuxy cell (0,0). */
  private realign(): void {
    if (!this.host || !this.alignTo) return;
    const panes = Array.from(
      this.alignTo.querySelectorAll<HTMLElement>('.pane-layout-item[data-pane-id]'),
    );
    if (panes.length === 0) return;
    // --cell-w lives on the app root, a descendant of alignTo — read it off a
    // pane, which inherits it.
    const cellW = parseFloat(getComputedStyle(panes[0]).getPropertyValue('--cell-w'));
    if (!(cellW > 0)) return;
    const origin = this.alignTo.getBoundingClientRect();
    let left = Infinity;
    let top = Infinity;
    for (const p of panes) {
      const r = p.getBoundingClientRect();
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
    }
    this.host.style.left = `${left - origin.left + cellW / 2}px`;
    this.host.style.top = `${top - origin.top}px`;
  }
}

/** The shape v86's own text screen had, which tmuxView.css styles: a <div> of
 *  one <div> per row, the cursor a `.cursor` span on its row. */
function createScreen(): HTMLElement {
  const screen = document.createElement('div');
  screen.className = 'vga-screen';
  screen.appendChild(document.createElement('div'));
  return screen;
}

function paint(screen: HTMLElement, { rows, cursor }: VgaScreen): void {
  const text = screen.firstElementChild as HTMLElement;
  while (text.childElementCount > rows.length) text.lastElementChild?.remove();
  while (text.childElementCount < rows.length) text.appendChild(document.createElement('div'));
  rows.forEach((row, i) => {
    const line = text.children[i] as HTMLElement;
    if (cursor?.row !== i) {
      line.textContent = row;
      return;
    }
    const mark = document.createElement('span');
    mark.className = 'cursor';
    mark.textContent = row[cursor.col] ?? ' ';
    line.replaceChildren(row.slice(0, cursor.col), mark, row.slice(cursor.col + 1));
  });
}
