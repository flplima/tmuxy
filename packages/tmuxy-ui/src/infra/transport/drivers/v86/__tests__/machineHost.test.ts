import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineEvent, MachineRequest } from '../machine';
import { SCREEN_POLL_MS, serveMachine, type MachineScope } from '../machineHost';
import { CHUNK_BYTES, SERIAL_FLUSH_MS } from '../serialLink';
import type { V86Emulator } from '../v86Guest';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** An emulator that records what reaches its UART and prints on demand. */
function fakeEmulator() {
  let printByte: (byte: number) => void = () => {};
  const rows = Array.from({ length: 25 }, () => ' '.repeat(80));
  const restored: string[] = [];
  const emu = {
    add_listener: (event: string, cb: (byte: number) => void) => {
      if (event === 'serial0-output-byte') printByte = cb;
    },
    serial0_send: vi.fn(),
    restore_state: vi.fn(async (state: ArrayBuffer) => {
      restored.push(new TextDecoder().decode(state));
    }),
    run: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    screen_adapter: { get_text_screen: () => [...rows], update_cursor: () => {} },
    v86: { cpu: { current_tsc: new Uint32Array(2), store_current_tsc() {}, set_tsc() {} } },
  };
  const print = (text: string) => {
    for (const byte of new TextEncoder().encode(text)) printByte(byte);
  };
  return { emu: emu as V86Emulator, raw: emu, rows, print, restored };
}

const GENERIC = '/v86-img/tmux-state.bin.zst';
const DEMO = '/v86-img/demo-state.bin.zst';

/** A state whose bytes are its own URL, so a restore says which it was. */
const stateAt = async (url: string) => new TextEncoder().encode(url).buffer;

/** A worker scope the test sends requests into and reads events out of. */
function host(snapshot: (url: string) => Promise<ArrayBuffer> = stateAt) {
  const machine = fakeEmulator();
  const fetched: string[] = [];
  const events: MachineEvent[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const scope = {
    postMessage: (event: MachineEvent) => void events.push(event),
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      void listeners.set(type, listener),
  } as MachineScope;
  serveMachine(scope, {
    createEmulator: async () => ({ emu: machine.emu, loaded: Promise.resolve() }),
    fetchSnapshot: (url) => {
      fetched.push(url);
      return snapshot(url);
    },
  });
  const send = (request: MachineRequest) => listeners.get('message')?.({ data: request });
  // Microtasks only: a timer run here would pace a write the test means to drop.
  const answered = async (id: number) => {
    for (let hop = 0; hop < 100; hop++) {
      const done = events.find((e) => e.type === 'done' && e.id === id);
      if (done) return done;
      await Promise.resolve();
    }
    throw new Error(`request ${id} was never answered`);
  };
  return { machine, events, listeners, send, answered, fetched };
}

describe("the machine's worker", () => {
  it('boots by restoring the state it is named and running it, and answers when it runs', async () => {
    const { machine, send, answered } = host();
    send({ type: 'boot', url: DEMO, id: 1 });
    expect(await answered(1)).toEqual({ type: 'done', id: 1, error: null });
    expect(machine.restored).toEqual([DEMO]);
    expect(machine.raw.run).toHaveBeenCalledTimes(1);
  });

  it('has the machine wait while its guest is halted, from the boot on', async () => {
    const delays: number[] = [];
    vi.stubGlobal('scheduler', {
      postTask: (_task: () => void, options?: { delay?: number }) => {
        delays.push(options?.delay ?? 0);
        return Promise.resolve();
      },
    });
    try {
      const { machine, send, answered } = host();
      const ownYield = vi.fn();
      Object.assign(machine.raw.v86, { yield: ownYield, yield_callback: () => {} });
      send({ type: 'boot', url: DEMO, id: 1 });
      await answered(1);

      (machine.raw.v86 as unknown as { yield(ms: number, tick: number): void }).yield(0.3, 1);
      expect(delays).toEqual([1]);
      expect(ownYield).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rewinds to whichever state each restore names, fetching each one once', async () => {
    const { machine, send, answered, fetched } = host();
    send({ type: 'boot', url: GENERIC, id: 1 });
    await answered(1);
    [DEMO, GENERIC, DEMO].forEach((url, i) => send({ type: 'restore', url, id: i + 2 }));
    for (const id of [2, 3, 4]) expect(await answered(id)).toMatchObject({ error: null });
    expect(machine.restored).toEqual([GENERIC, DEMO, GENERIC, DEMO]);
    expect(fetched).toEqual([GENERIC, DEMO]);
  });

  it('answers a boot whose snapshot cannot be fetched with the reason, rather than never', async () => {
    const { send, answered } = host(async () => {
      throw new Error('guest snapshot /v86-img/tmux-state.bin.zst: HTTP 404');
    });
    send({ type: 'boot', url: GENERIC, id: 1 });
    expect(await answered(1)).toMatchObject({
      error: 'guest snapshot /v86-img/tmux-state.bin.zst: HTTP 404',
    });
  });

  it('sends the guest output in one chunk per burst', async () => {
    const { machine, events, send, answered } = host();
    send({ type: 'boot', url: GENERIC, id: 1 });
    await answered(1);
    machine.print('héllo');
    vi.advanceTimersByTime(SERIAL_FLUSH_MS);
    const serial = events.filter((e) => e.type === 'serial');
    expect(serial.map((e) => new TextDecoder().decode(e.bytes))).toEqual(['héllo']);
  });

  it("forgets on a restore both the old machine's last output and the input queued for it", async () => {
    const { machine, events, send, answered } = host();
    send({ type: 'boot', url: GENERIC, id: 1 });
    await answered(1);
    send({ type: 'write', bytes: new Uint8Array(3 * CHUNK_BYTES) });
    machine.print('old prompt$ ');
    send({ type: 'restore', url: GENERIC, id: 2 });
    await answered(2);
    vi.advanceTimersByTime(100);
    expect(machine.raw.serial0_send).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'serial')).toEqual([]);
    expect(machine.raw.restore_state).toHaveBeenCalledTimes(2);
  });

  it('sends the text console while watched, only when it changed', async () => {
    const { machine, events, send, answered } = host();
    send({ type: 'boot', url: GENERIC, id: 1 });
    await answered(1);
    const screens = () => events.filter((e) => e.type === 'screen');
    send({ type: 'watch-screen', on: true });
    vi.advanceTimersByTime(3 * SCREEN_POLL_MS);
    expect(screens()).toHaveLength(1);
    machine.rows[0] = `[0] 0:bash*${' '.repeat(68)}`;
    vi.advanceTimersByTime(SCREEN_POLL_MS);
    expect(screens()).toHaveLength(2);
    send({ type: 'watch-screen', on: false });
    machine.rows[1] = 'x'.repeat(80);
    vi.advanceTimersByTime(3 * SCREEN_POLL_MS);
    expect(screens()).toHaveLength(2);
  });

  it('stops the emulator on a pause and runs it again on a resume', async () => {
    const { machine, send, answered } = host();
    send({ type: 'boot', url: GENERIC, id: 1 });
    await answered(1);
    send({ type: 'pause' });
    expect(machine.raw.stop).toHaveBeenCalledTimes(1);
    expect(machine.raw.run).toHaveBeenCalledTimes(1);
    send({ type: 'resume' });
    expect(machine.raw.run).toHaveBeenCalledTimes(2);
  });

  it('reports a rejection nothing handled, which would otherwise never leave the worker', () => {
    const { events, listeners } = host();
    listeners.get('unhandledrejection')?.({ reason: new Error('9p: no such file') });
    expect(events).toEqual([{ type: 'fatal', message: '9p: no such file' }]);
  });
});
