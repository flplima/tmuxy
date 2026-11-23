/**
 * The v86 machine as the page sees it. The emulator runs in a dedicated Web
 * Worker (`machine.worker.ts`, its logic in `machineHost.ts`): v86 runs the
 * guest CPU in 1 ms slices on the thread that made it, and on the page's main
 * thread those slices competed with React and the terminal renderer for every
 * frame. The worker keeps the emulator, the states' bytes, the paced writes
 * to the UART and the gathering of its output; the control-mode core stays
 * on the page, in `GuestEngine`.
 *
 *   page                                   worker
 *   boot / restore (state URL) ──id──>     emulator, states by URL
 *   write (bytes, transferred) ──────>     paced UART writes
 *   watch-screen on|off        ──────>     text console poll
 *                              <──id──     done (error | null)
 *                              <──────     serial (one chunk per 8 ms burst)
 *                              <──────     screen (rows, cursor)
 *                              <──────     fatal (the worker failed)
 */

/** The guest's VGA text console: its rows, and where its cursor is. */
export interface VgaScreen {
  rows: string[];
  cursor: { row: number; col: number } | null;
}

/** The requests the worker answers, under the id they were sent with; `url`
 *  names the machine state, which the worker fetches once and keeps. */
type MachineCall = { type: 'boot'; url: string } | { type: 'restore'; url: string };

export type MachineRequest =
  | (MachineCall & { id: number })
  | { type: 'write'; bytes: Uint8Array }
  | { type: 'watch-screen'; on: boolean };

export type MachineEvent =
  | { type: 'done'; id: number; error: string | null }
  | { type: 'serial'; bytes: Uint8Array }
  | { type: 'screen'; screen: VgaScreen }
  | { type: 'fatal'; message: string };

/** What the machine tells the page without being asked. */
export interface MachineHandlers {
  serial(bytes: Uint8Array): void;
  screen(screen: VgaScreen): void;
  /** The machine failed with nothing pending to fail instead. */
  fatal(message: string): void;
}

export interface V86Machine {
  /** Start the emulator, restore the state at `url` and run it. */
  boot(url: string): Promise<void>;
  /** Rewind the running machine to the state at `url`. Nothing the machine
   *  printed before the rewind arrives after this resolves, and bytes still
   *  queued for its UART are dropped. */
  restore(url: string): Promise<void>;
  /** Queue bytes for the UART; the worker paces them. */
  write(bytes: Uint8Array): void;
  watchScreen(on: boolean): void;
  destroy(): void;
}

/** The page's end of the worker: what `connectMachine` needs of a `Worker`. */
export interface MachinePort {
  postMessage(request: MachineRequest, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<MachineEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  terminate(): void;
}

/** Why the worker failed: an uncaught error's message. A worker whose script
 *  never loaded fires a bare `error` event, with none. */
function failureOf(event: ErrorEvent): string {
  return event.message || "the guest machine's worker could not be loaded";
}

/**
 * The machine over `port`. A failure of the worker (an error it did not
 * catch, a rejection, a script that never loaded) fails whatever is pending
 * with its reason, so a start that cannot happen rejects instead of waiting
 * forever; with nothing pending it reaches `handlers.fatal`. Either way the
 * machine is done: later calls fail with the same reason.
 */
export function connectMachine(port: MachinePort, handlers: MachineHandlers): V86Machine {
  let nextId = 0;
  const pending = new Map<number, { resolve(): void; reject(err: Error): void }>();
  let failure: string | null = null;

  /** Ends the machine; whether anything pending was failed with it. */
  const end = (message: string): boolean => {
    if (failure !== null) return false;
    failure = message;
    const waiters = [...pending.values()];
    pending.clear();
    for (const waiter of waiters) waiter.reject(new Error(message));
    return waiters.length > 0;
  };
  const fail = (message: string) => {
    if (failure === null && !end(message)) handlers.fatal(message);
  };

  const call = (request: MachineCall) => {
    if (failure !== null) return Promise.reject(new Error(failure));
    const id = ++nextId;
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ ...request, id }, []);
    });
  };

  port.onmessage = ({ data: event }) => {
    switch (event.type) {
      case 'done': {
        const waiter = pending.get(event.id);
        pending.delete(event.id);
        if (event.error === null) waiter?.resolve();
        else waiter?.reject(new Error(event.error));
        return;
      }
      case 'serial':
        return handlers.serial(event.bytes);
      case 'screen':
        return handlers.screen(event.screen);
      case 'fatal':
        return fail(event.message);
    }
  };
  port.onerror = (event) => {
    event.preventDefault();
    fail(failureOf(event));
  };
  port.onmessageerror = () => fail("a message from the guest machine's worker could not be read");

  return {
    boot: (url) => call({ type: 'boot', url }),
    restore: (url) => call({ type: 'restore', url }),
    write: (bytes) => {
      if (failure === null) port.postMessage({ type: 'write', bytes }, [bytes.buffer]);
    },
    watchScreen: (on) => {
      if (failure === null) port.postMessage({ type: 'watch-screen', on }, []);
    },
    destroy: () => {
      end('the guest machine was destroyed');
      port.terminate();
    },
  };
}

/**
 * A worker of its own per machine, as a module worker: it imports v86 at
 * runtime from the served `/v86/libv86.mjs`, never through the bundler (see
 * `createV86Emulator`), and the bundler gives it its own chunk.
 */
export function spawnV86Machine(handlers: MachineHandlers): V86Machine {
  const worker = new Worker(new URL('./machine.worker.ts', import.meta.url), {
    type: 'module',
    name: 'v86',
  });
  return connectMachine(worker, handlers);
}
