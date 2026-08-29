/**
 * VgaMirror — shows the RAW tmux TUI behind a v86 story.
 *
 * The guest's tmux server already serves tmuxy's control-mode client on the
 * serial line. This attaches a SECOND, ordinary client on the guest's VGA text
 * console (/dev/tty1) and displays v86's own rendering of that console: rows
 * of coloured spans painted by the emulator's ScreenAdapter (see
 * `V86Engine.getScreen`). What you see is tmux drawing itself — borders,
 * pane-border-status line, status bar, cursor — with no tmuxy code in the
 * path, which makes it the reference to compare the React rendering against.
 *
 * The client is read-only (`-r`) and excluded from window sizing
 * (`-f ignore-size`), so it never steals input or resizes the window the
 * tmuxy control client sized. The guest VGA console is a fixed 80x25
 * terminal; the tmux window the tmuxy client drives is 64x20, which tmux
 * draws top-left and leaves the rest of the console blank — the side-mode CSS
 * crops the screen to that 64x20 window so the panel reads as a 64x20 console
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

import { getSharedEngine, type V86Engine } from '../tmux/v86/V86Engine';

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
  private host: HTMLElement | null = null;
  private alignTo: HTMLElement | null = null;
  private offReady: (() => void) | null = null;
  private realignTimer: ReturnType<typeof setInterval> | null = null;
  private revealed = false;

  mount(host: HTMLElement, options: VgaMirrorOptions = {}): void {
    this.host = host;
    this.alignTo = options.alignTo ?? null;
    // Reveal the console (reparent the shared screen into the visible DOM, start
    // painting, start realigning) ONLY once the engine is booted, and (re)attach
    // the read-only VGA client on every attach. Reparenting the screen_container
    // into a VISIBLE tree BEFORE a cold boot makes v86 lay out and paint the
    // console every frame while it restores the snapshot, which slows the guest
    // enough that the app's bounded attach window elapses before tmux answers —
    // the story then boots to a bare 0-pane shell. Deferring keeps a cold boot
    // as fast (detached, unpainted screen) as a no-mirror story.
    this.offReady = this.engine.onReady(() => {
      this.reveal();
      this.attach();
    });
    if (this.engine.isBooted()) {
      this.reveal();
      this.attach();
    }
  }

  /** Idempotently reparent the shared screen into the panel and start painting +
   *  realigning. Runs once the engine is booted (see `mount`). */
  private reveal(): void {
    if (this.revealed || !this.host) return;
    this.revealed = true;
    const screen = this.engine.getScreen();
    screen.classList.add('vga-screen');
    this.host.appendChild(screen);
    this.engine.setScreenPainting(true);
    if (this.alignTo) {
      this.realign();
      this.realignTimer = setInterval(() => this.realign(), REALIGN_MS);
    }
  }

  unmount(): void {
    this.offReady?.();
    this.offReady = null;
    if (this.realignTimer) clearInterval(this.realignTimer);
    this.realignTimer = null;
    if (this.engine.isBooted()) this.engine.send(DETACH_VGA);
    this.engine.setScreenPainting(false);
    this.engine.getScreen().remove();
    this.revealed = false;
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
