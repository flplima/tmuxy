import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineSink } from '../../guest/GuestEngine';
import type { Feed } from '../../guest/controlMode';
import type { MachineHandlers, V86Machine } from '../machine';
import { V86Engine } from '../V86Engine';
import { attachLine, guestSnapshot } from '../v86Guest';

/** What the control-mode core was fed: the engine's decoding is under test.
 *  A core that was fed anything reports a pane, which ends a start. */
const core = vi.hoisted(() => ({
  fed: [] as string[],
  ticks: 0,
  ran: [] as { command: string; replyId?: number }[],
  /** The reply the core hands back with its next feed. */
  answer: null as { id: number; output: string } | null,
}));

vi.mock('../../guest/controlMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../guest/controlMode')>();
  const quiet = (): Feed => ({
    commands: [],
    changed: false,
    clipboard: [],
    messages: [],
    errors: [],
    replies: [],
    ended: null,
  });
  const withPane = {
    ...actual.EMPTY_STATE,
    panes: [{}] as unknown as typeof actual.EMPTY_STATE.panes,
  };
  class Core {
    private fedAny = false;
    feed(text: string) {
      core.fed.push(text);
      this.fedAny = true;
      const feed = { ...quiet(), changed: true };
      if (core.answer) feed.replies.push({ ...core.answer, error: null });
      core.answer = null;
      return feed;
    }
    tick() {
      core.ticks++;
      return quiet();
    }
    run(command: string, replyId?: number) {
      core.ran.push({ command, replyId });
      return quiet();
    }
    setClientSize = quiet;
    attach = () => [];
    resync = () => [];
    expectSession() {}
    snapshot = () => (this.fedAny ? withPane : actual.EMPTY_STATE);
    image_url = () => undefined;
    parse_scrollback = () => [];
  }
  return { ...actual, loadWasmModule: async () => ({ WasmTmux: Core }) };
});

interface MachineScript {
  failBoot?: string;
  /** What the guest does with bytes written to its UART. */
  onWrite?: (bytes: Uint8Array, handlers: MachineHandlers) => void;
}

/** Machines the engine spawns, each answering at once unless told to fail. */
function machines({ failBoot, onWrite }: MachineScript = {}) {
  const spawned: { machine: V86Machine; handlers: MachineHandlers }[] = [];
  const spawn = (handlers: MachineHandlers): V86Machine => {
    const machine: V86Machine = {
      boot: vi.fn(async () => {
        if (failBoot) throw new Error(failBoot);
      }),
      restore: vi.fn(async () => {}),
      write: vi.fn((bytes: Uint8Array) => onWrite?.(bytes, handlers)),
      watchScreen: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn(),
    };
    spawned.push({ machine, handlers });
    return machine;
  };
  return { spawn, spawned, last: () => spawned[spawned.length - 1] };
}

/** The attach is `GuestEngine.start`'s, tested on its own: here it only
 *  records that it ran and lets the stream through. */
class Engine extends V86Engine {
  readonly starts: string[] = [];
  /** What the guest printed, as the machine delivers it. */
  hear(text: string): void {
    this.receive(text);
  }
  protected async start(_initCommands: string[], attachLine: string): Promise<void> {
    this.starts.push(attachLine);
    this.attached = true;
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const GENERIC = guestSnapshot('generic');
const DEMO = guestSnapshot('demo');
/** What a `tmux -CC` client writes the moment it is attached. */
const DCS = '\x1bP1000p';

describe('the v86 engine over its machine', () => {
  it("boots the machine on the snapshot's state, then attaches at its session", async () => {
    const { spawn, last } = machines();
    const engine = new Engine(spawn);
    await engine.boot(DEMO, []);
    expect(last().machine.boot).toHaveBeenCalledWith('/v86-img/demo-state.bin.zst');
    expect(engine.starts).toEqual([attachLine('tmuxy')]);
    expect(engine.isBooted()).toBe(true);
  });

  it('decodes a character split across two chunks whole, once per chunk', async () => {
    core.fed.length = 0;
    const { spawn, last } = machines();
    const engine = new Engine(spawn);
    await engine.boot(GENERIC, []);
    const bytes = utf8('a中🙂b');
    last().handlers.serial(bytes.subarray(0, 2));
    last().handlers.serial(bytes.subarray(2, 5));
    last().handlers.serial(bytes.subarray(5));
    expect(core.fed).toEqual(['a', '中', '🙂b']);
  });

  it('fails the replies in flight on a reset, and starts the next machine with no half character', async () => {
    core.fed.length = 0;
    const { spawn, spawned, last } = machines();
    const engine = new Engine(spawn);
    await engine.boot(GENERIC, []);
    const reply = engine.ask('display-message -p x');
    last().handlers.serial(utf8('a中').subarray(0, 3));

    await engine.reset(GENERIC, []);
    await expect(reply).resolves.toEqual({ output: '', error: 'engine reset' });
    expect(last().machine.restore).toHaveBeenCalledWith('/v86-img/tmux-state.bin.zst');
    expect(spawned).toHaveLength(1);

    last().handlers.serial(utf8('$ '));
    expect(core.fed).toEqual(['a', '$ ']);
  });

  it('fails a start the worker cannot make with its reason, and boots a new machine next time', async () => {
    const { spawn, spawned } = machines({ failBoot: '/v86/v86.wasm: HTTP 404' });
    const engine = new Engine(spawn);
    await expect(engine.boot(GENERIC, [])).rejects.toThrow('/v86/v86.wasm: HTTP 404');
    expect(engine.isBooted()).toBe(false);
    expect(spawned[0].machine.destroy).toHaveBeenCalled();

    await expect(engine.reset(GENERIC, [])).rejects.toThrow('HTTP 404');
    expect(spawned).toHaveLength(2);
    expect(spawned[1].machine.restore).not.toHaveBeenCalled();
  });

  it("tells the app when a running machine's worker fails", async () => {
    const { spawn, last } = machines();
    const engine = new Engine(spawn);
    const sink = { onFatal: vi.fn() } as unknown as EngineSink;
    await engine.boot(GENERIC, []);
    engine.setSink(sink);
    last().handlers.fatal('memory access out of bounds');
    expect(sink.onFatal).toHaveBeenCalledWith(
      'the guest machine stopped: memory access out of bounds',
    );
    expect(last().machine.destroy).toHaveBeenCalled();
    expect(engine.isBooted()).toBe(false);
  });

  it('has the machine read its console only while someone watches it', async () => {
    const { spawn, last } = machines();
    const engine = new Engine(spawn);
    const seen = vi.fn();
    const stop = engine.watchScreen(seen);
    await engine.boot(GENERIC, []);
    expect(last().machine.watchScreen).toHaveBeenLastCalledWith(true);
    const screen = { rows: ['$ '], cursor: { row: 0, col: 2 } };
    last().handlers.screen(screen);
    expect(seen).toHaveBeenCalledWith(screen);
    stop();
    expect(last().machine.watchScreen).toHaveBeenLastCalledWith(false);
  });

  it("attaches the next machine on its own client's announcement, whatever the old one printed as it was rewound", async () => {
    vi.useFakeTimers();
    core.fed.length = 0;
    // Each machine echoes the attach line it was typed, then its client
    // announces itself; the second one's echo could finish the first one's
    // last, half-written marker.
    const answers = [`${DCS}%begin 1`, `00p$ ${DCS}%begin 2`];
    const { spawn, last } = machines({
      onWrite: (bytes, handlers) => {
        if (new TextDecoder().decode(bytes) === attachLine('m')) {
          handlers.serial(utf8(answers.shift()!));
        }
      },
    });
    const engine = new V86Engine(spawn);
    await engine.boot(GENERIC, []);
    expect(core.fed).toEqual(['%begin 1']);

    let rewound: (() => void) | null = null;
    vi.mocked(last().machine.restore).mockImplementation(
      () => new Promise<void>((resolve) => (rewound = resolve)),
    );
    const reset = engine.reset(GENERIC, []);
    for (let hop = 0; hop < 100 && !rewound; hop++) await Promise.resolve();
    last().handlers.serial(new Uint8Array([0xe4, 0xb8, ...utf8('\x1bP10')]));
    rewound!();
    await reset;

    expect(core.fed).toEqual(['%begin 1', '%begin 2']);
    engine.destroy();
    vi.useRealTimers();
  });
});

describe('pausing the machine', () => {
  const PAUSE_MS = 10 * 60 * 1000;

  async function booted() {
    vi.useFakeTimers();
    core.ticks = 0;
    core.ran.length = 0;
    const { spawn, last } = machines();
    const engine = new Engine(spawn);
    await engine.boot(GENERIC, []);
    return { engine, machine: last().machine };
  }
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the machine and the core's tick for as long as the pause lasts", async () => {
    const { engine, machine } = await booted();
    vi.advanceTimersByTime(200);
    const before = core.ticks;
    expect(before).toBeGreaterThan(0);

    expect(engine.pause()).toBe(true);
    expect(machine.pause).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(core.ticks).toBe(before);

    engine.resume();
    expect(machine.resume).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(core.ticks).toBeGreaterThan(before);
  });

  it('refuses to pause while a caller waits on a reply, and pauses once it is answered', async () => {
    const { engine, machine } = await booted();
    const reply = engine.ask('display-message -p x');
    expect(engine.pause()).toBe(false);
    expect(machine.pause).not.toHaveBeenCalled();

    core.answer = { id: core.ran[0].replyId ?? 0, output: 'x' };
    engine.hear('%begin');
    await expect(reply).resolves.toEqual({ output: 'x', error: null });
    expect(engine.pause()).toBe(true);
  });

  it('holds what is asked of the machine and sends it, in order, on resume', async () => {
    const { engine, machine } = await booted();
    engine.pause();
    engine.send('first');
    engine.run('send-keys a');
    engine.send('second');
    const answer = engine.ask('display-message -p x');
    vi.advanceTimersByTime(PAUSE_MS);
    expect(machine.write).not.toHaveBeenCalled();
    expect(core.ran).toEqual([]);

    engine.resume();
    expect(
      vi.mocked(machine.write).mock.calls.map(([bytes]) => new TextDecoder().decode(bytes)),
    ).toEqual(['first\n', 'second\n']);
    expect(core.ran.map((c) => c.command)).toEqual(['send-keys a', 'display-message -p x']);

    // The core got the question at the resume, so its reply clock (5 s) did not run in the pause.
    core.answer = { id: core.ran[1].replyId ?? 0, output: 'x' };
    engine.hear('%begin');
    await expect(answer).resolves.toEqual({ output: 'x', error: null });
  });

  it('drops what was held when the machine is rewound, and runs it again', async () => {
    const { engine, machine } = await booted();
    engine.pause();
    const stale = engine.ask('display-message -p x');
    await engine.reset(GENERIC, []);
    await expect(stale).resolves.toEqual({ output: '', error: 'engine reset' });
    expect(engine.isPaused()).toBe(false);
    expect(machine.resume).toHaveBeenCalledTimes(1);
    expect(core.ran).toEqual([]);
  });

  it('does not pause while a start is queued or running, and a reset leaves the next one clean', async () => {
    const { engine, machine } = await booted();
    expect(engine.pause()).toBe(true);
    await engine.reset(GENERIC, []);
    expect(machine.resume).toHaveBeenCalledTimes(1);
    expect(engine.isPaused()).toBe(false);

    const resetting = engine.reset(GENERIC, []);
    expect(engine.pause()).toBe(false);
    await resetting;
    expect(engine.pause()).toBe(true);
  });

  it('does not pause a machine that is not attached', async () => {
    vi.useFakeTimers();
    const { spawn } = machines();
    const engine = new V86Engine(spawn);
    expect(engine.pause()).toBe(false);
  });
});
