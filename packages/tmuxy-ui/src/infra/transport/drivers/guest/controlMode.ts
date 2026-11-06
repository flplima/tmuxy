/**
 * What a control-mode client in an in-browser guest needs whatever machine
 * the guest runs in (v86, CheerpX): the tmuxy-core client compiled to wasm
 * (`packages/tmuxy-wasm`), and the promises a host keeps for the replies it
 * asked for.
 */
import type { ServerStateEncoded } from '../../../../domain/wire';
import type { PaneContent } from '../../../../domain/wireCells';

const WASM_JS = '/wasm/tmuxy_wasm.js';
const WASM_BG = '/wasm/tmuxy_wasm_bg.wasm';

/** What the core asks of the host after a feed, a tick or a command
 *  (`Feed` in `packages/tmuxy-wasm/src/lib.rs`). */
export interface Feed {
  commands: string[];
  changed: boolean;
  clipboard: { paneId: string | null; text: string }[];
  messages: string[];
  errors: string[];
  replies: { id: number; output: string; error: string | null }[];
  ended: { reason: string | null } | null;
}

export type Routed = { routed: string } | { blocked: string };

export interface WasmCore {
  attach(cols: number, rows: number): string[];
  feed(text: string): Feed;
  tick(): Feed;
  run(command: string, replyId?: number): Feed;
  setClientSize(cols: number, rows: number): Feed;
  resync(): string[];
  expectSession(session: string): void;
  snapshot(): ServerStateEncoded;
  image_url(paneId: string, imageId: number): string | undefined;
  parse_scrollback(text: string, width: number): PaneContent;
}

export interface WasmModule {
  default(input?: string): Promise<unknown>;
  WasmTmux: new (session: string) => WasmCore;
  routeCommand(command: string, session: string, cols?: number, rows?: number): Routed;
  routeQuery(command: string): Routed;
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

export interface Reply {
  output: string;
  error: string | null;
}

/**
 * The callers waiting on a reply, by the id the core answers them under. The
 * core times a reply out itself (its `REPLY_TIMEOUT`), so every id it was
 * handed resolves; `failAll` settles the rest when the machine goes away.
 */
export class ReplyBook {
  private nextId = 0;
  private waiting = new Map<number, (reply: Reply) => void>();

  open(): { id: number; reply: Promise<Reply> } {
    const id = ++this.nextId;
    const reply = new Promise<Reply>((resolve) => this.waiting.set(id, resolve));
    return { id, reply };
  }

  resolve(id: number, reply: Reply): void {
    const waiter = this.waiting.get(id);
    this.waiting.delete(id);
    waiter?.(reply);
  }

  failAll(reason: string): void {
    const waiters = [...this.waiting.values()];
    this.waiting.clear();
    for (const waiter of waiters) waiter({ output: '', error: reason });
  }
}
