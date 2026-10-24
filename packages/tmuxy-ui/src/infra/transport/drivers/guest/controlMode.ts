/**
 * What a control-mode client in an in-browser guest needs whatever machine
 * the guest runs in (v86, CheerpX): the tmuxy-core engine compiled to wasm,
 * the per-attach tmux settings, and the bookkeeping that picks tracked
 * command outcomes and scrollback captures out of the control-mode stream.
 */
import type { PaneContent, ServerStateEncoded, StateUpdateEncoded } from '../../../../domain/wire';

const WASM_JS = '/wasm/tmuxy_wasm.js';
const WASM_BG = '/wasm/tmuxy_wasm_bg.wasm';

// Guest bootstrap commands sent after every attach. Everything durable
// (script paths, command-aliases, config, PS1, symlinks) is BAKED into the
// guest image (scripts/build-v86-snapshot.mjs, scripts/build-cheerpx-image.mjs),
// so only per-attach setup belongs here: the same session-level
// settings the native monitor's enforce_settings() applies on connect
// (allow-passthrough gates image/hyperlink OSC forwarding; pane-border-status
// top is assumed by PaneLayout's geometry).
export const GUEST_SETUP: string[] = [
  // GLOBAL (-g) so EVERY window — including tabs born later from
  // `new-window` → splitw+breakp — inherits it. Without -g it's a per-window
  // option that only lands on the window active at attach, leaving new tabs at
  // pane y=0 where PaneHeader steals the first content row. tmux 3.7a in the
  // guest has no issue with -g here (the 3.5a control-mode caveat that keeps the
  // native monitor per-session does not apply to the guests' tmux).
  'set -g pane-border-status top',
  "set -g pane-border-format ' '",
  'set mouse on',
  'set focus-events on',
  'set allow-passthrough on',
  'set allow-rename on',
  'set set-titles on',
  'setw -g aggressive-resize off',
];

export interface FeedOutput {
  updates: StateUpdateEncoded[];
  commands: string[];
  clipboard: [string, string][];
  /** (success, first output line) per %begin/%end/%error block, in order. */
  responses: [boolean, string][];
}

export interface WasmCore {
  feed(text: string): FeedOutput;
  tick(): FeedOutput;
  snapshot(): ServerStateEncoded;
  initial_sync(): string[];
  image_url(paneId: string, imageId: number): string | undefined;
  parse_scrollback(text: string, width: number): PaneContent;
}

export interface WasmModule {
  default(input?: string): Promise<unknown>;
  WasmTmux: new (session: string) => WasmCore;
}

export const EMPTY_STATE: ServerStateEncoded = {
  session_name: 'm',
  active_window_id: null,
  active_pane_id: null,
  panes: [],
  windows: [],
  total_width: 64,
  total_height: 20,
};

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The engine's JS glue is a served file, not a module of the bundle. */
export async function loadWasmModule(): Promise<WasmModule> {
  const wasm = (await import(
    /* @vite-ignore */ /* webpackIgnore: true */ WASM_JS
  )) as unknown as WasmModule;
  await wasm.default(WASM_BG);
  return wasm;
}

/** The notifications tmux's control mode sends (tmux(1), CONTROL MODE). */
const TMUX_NOTIFICATION =
  /^%(?:client-detached|client-session-changed|config-error|continue|exit|extended-output|layout-change|message|output|pane-mode-changed|paste-buffer-changed|paste-buffer-deleted|pause|session-changed|session-renamed|session-window-changed|sessions-changed|subscription-changed|unlinked-window-add|unlinked-window-close|unlinked-window-renamed|window-add|window-close|window-pane-changed|window-renamed)(?: |$)/;

/**
 * Command output picked out of the control-mode stream: a command is
 * bracketed by two unique `display-message` markers, and what it printed is
 * what came between them, less tmux's notifications. Those arrive between
 * output blocks (`%begin` … `%end`), never inside one — and so does what a
 * `run-shell` job prints, after its block has closed empty, so a line between
 * blocks is the command's unless it is a notification: another pane's
 * `%output` arriving meanwhile is not. Commands reach tmux in order, so at
 * most one capture is collecting at a time.
 */
export class CaptureBook {
  private captureSeq = 0;
  private captures = new Map<
    string,
    { lines: string[]; resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private activeId: string | null = null;
  /** The arguments of the open output block's `%begin` (time, number,
   *  flags), which its `%end` or `%error` repeats; null between blocks. */
  private block: string | null = null;
  private lineBuf = '';

  /** Run `command` and resolve with what it printed: empty when it fails, or
   *  when tmux does not answer within 15s. */
  capture(command: string, send: (cmd: string) => void): Promise<string> {
    const id = String(++this.captureSeq);
    const startMark = `TMUXY_CAP_START_${id}`;
    const endMark = `TMUXY_CAP_END_${id}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.captures.delete(id)) {
          if (this.activeId === id) this.activeId = null;
          resolve('');
        }
      }, 15000);
      this.captures.set(id, { lines: [], resolve, timer });
      // Three lines, as `reply_wrapped_lines` sends them (invariant A6): a
      // command can fail (a capture of a pane that is gone), tmux stops a
      // `;` list at its first error, and an END marker on the same line would
      // never run.
      send(`display-message -p '${startMark}'`);
      send(command);
      send(`display-message -p '${endMark}'`);
    });
  }

  /**
   * Scan a raw control-mode chunk for capture markers and collect what the
   * command printed between them. A block closes on the `%end` or `%error`
   * that repeats its `%begin`'s arguments, so a printed line that merely
   * starts with `%end` is content. A capture that fails (`%error`) is history
   * nobody has, so tmux's message is dropped rather than shown as it.
   */
  scanChunk(chunk: string): void {
    this.lineBuf += chunk;
    const parts = this.lineBuf.split('\n');
    // Keep the trailing partial line for the next chunk.
    this.lineBuf = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (this.block === null) {
        if (line.startsWith('%begin ')) {
          this.block = line.slice('%begin '.length);
          continue;
        }
        if (TMUX_NOTIFICATION.test(line)) continue;
      } else if (line === `%end ${this.block}` || line === `%error ${this.block}`) {
        this.block = null;
        if (line.startsWith('%error') && this.activeId !== null) {
          this.captures.get(this.activeId)?.lines.splice(0);
          this.activeId = null;
        }
        continue;
      }
      const startIdx = line.indexOf('TMUXY_CAP_START_');
      if (startIdx !== -1) {
        this.activeId = line.slice(startIdx + 'TMUXY_CAP_START_'.length).trim();
        continue;
      }
      const endIdx = line.indexOf('TMUXY_CAP_END_');
      if (endIdx !== -1) {
        const id = line.slice(endIdx + 'TMUXY_CAP_END_'.length).trim();
        const cap = this.captures.get(id);
        if (cap) {
          clearTimeout(cap.timer);
          this.captures.delete(id);
          cap.resolve(cap.lines.join('\n'));
        }
        if (this.activeId === id) this.activeId = null;
        continue;
      }
      if (this.activeId !== null) this.captures.get(this.activeId)?.lines.push(line);
    }
  }

  failAll(): void {
    const captures = [...this.captures.values()];
    this.captures.clear();
    this.activeId = null;
    this.block = null;
    this.lineBuf = '';
    for (const c of captures) {
      clearTimeout(c.timer);
      c.resolve('');
    }
  }
}

/**
 * Tracked-command correlation. Control mode replies strictly in send order,
 * but the core also sends its own commands (captures, list-panes), so we
 * don't count blocks — we BRACKET each tracked command between two
 * display-message markers: every response between the start marker and the
 * end marker belongs to the tracked command. Counting segments was tried
 * and desyncs whenever a command argument contains a quoted ` ; ` (the
 * count overshoots and the tracker steals unrelated responses, shifting
 * every later correlation — the misattributed-outcome bug).
 *
 * The markers are their own LINES, as the native monitor sends them
 * (`reply_wrapped_lines`, invariant A6), never one `;` list with the
 * command: tmux stops a list at its first error, so an END marker sharing a
 * refused split's line never ran — the tracker then waited out its timeout,
 * swallowing every reply behind it, and reported "did not respond" for a
 * split tmux had answered "no space for a new pane" at once.
 */
export class TrackedCommandBook {
  /** How long a tracked command may go unanswered before it is reported as
   *  failed. Kept BELOW the store's acked-op backstop (10s) so the rejection
   *  reaches the op — a rollback with an error message — before the silent
   *  stale sweep does. */
  private static readonly TRACK_TIMEOUT_MS = 8000;

  private trackSeq = 0;
  private trackers = new Map<
    string,
    {
      ok: boolean;
      message: string;
      resolve(r: { ok: boolean; message: string }): void;
    }
  >();
  private armedTracker: string | null = null;

  onResponse(ok: boolean, firstLine: string): void {
    if (this.armedTracker) {
      const id = this.armedTracker;
      const t = this.trackers.get(id);
      if (!t) {
        this.armedTracker = null;
        return;
      }
      if (firstLine === `TMUXY_RC_END_${id}`) {
        this.trackers.delete(id);
        this.armedTracker = null;
        t.resolve({ ok: t.ok, message: t.message });
        return;
      }
      if (!ok && t.ok) {
        t.ok = false;
        t.message = firstLine;
      }
      return;
    }
    const m = firstLine.match(/^TMUXY_RC_(\d+)$/);
    if (m && this.trackers.has(m[1])) this.armedTracker = m[1];
  }

  sendTracked(
    cmd: string,
    send: (line: string) => void,
    onTimeout: () => void,
  ): Promise<{ ok: boolean; message: string }> {
    const id = String(++this.trackSeq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.trackers.delete(id)) {
          if (this.armedTracker === id) this.armedTracker = null;
          onTimeout();
          resolve({
            ok: false,
            message: `tmux did not respond within ${TrackedCommandBook.TRACK_TIMEOUT_MS}ms — the command may not have executed`,
          });
        }
      }, TrackedCommandBook.TRACK_TIMEOUT_MS);
      this.trackers.set(id, {
        ok: true,
        message: '',
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      send(`display-message -p 'TMUXY_RC_${id}'`);
      send(cmd);
      send(`display-message -p 'TMUXY_RC_END_${id}'`);
    });
  }

  failAll(reason: string): void {
    const trackers = [...this.trackers.values()];
    this.trackers.clear();
    this.armedTracker = null;
    for (const t of trackers) t.resolve({ ok: false, message: reason });
  }
}
