import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backendCall } from '../../../../../domain/backendCalls';
import { wirePane } from '../../../../../test/wire';
import { GuestTmuxAdapter } from '../GuestTmuxAdapter';
import {
  GuestEngine,
  type AttachTiming,
  type EngineSink,
  type GuestSnapshot,
} from '../GuestEngine';
import { EMPTY_STATE, type Feed } from '../controlMode';

/** The wasm core, as far as a start uses it: it answers `attach` with two
 *  commands, resizes the window to a viewport other than the one it was
 *  last given, has a pane once tmux streamed a layout, answers every command
 *  asked with a reply id at once, and keeps what it was asked to do. */
const wasm = vi.hoisted(() => ({
  fed: [] as string[],
  sized: [] as [number, number][],
  resyncs: 0,
  asked: [] as string[],
}));
vi.mock('../controlMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../controlMode')>();
  const quiet = (changed = false): Feed => ({
    commands: [],
    changed,
    clipboard: [],
    messages: [],
    errors: [],
    replies: [],
    ended: null,
  });
  class FakeCore {
    size = '';
    attach = (cols: number, rows: number) => {
      this.size = `${cols}x${rows}`;
      return [`refresh-client -C ${cols}x${rows}`, 'list-windows'];
    };
    feed = (text: string) => {
      wasm.fed.push(text);
      return quiet(text.includes('%layout-change'));
    };
    tick = () => quiet();
    run = (command: string, id?: number) => {
      if (id === undefined) return quiet();
      wasm.asked.push(command);
      return { ...quiet(), replies: [{ id, output: '', error: null }] };
    };
    setClientSize = (cols: number, rows: number) => {
      wasm.sized.push([cols, rows]);
      if (this.size === `${cols}x${rows}`) return quiet();
      this.size = `${cols}x${rows}`;
      return { ...quiet(), commands: [`resizew -x ${cols} -y ${rows}`] };
    };
    resync = () => {
      wasm.resyncs++;
      return [];
    };
    expectSession = () => {};
    snapshot = () => ({
      ...actual.EMPTY_STATE,
      panes: wasm.fed.join('').includes('%layout-change') ? [wirePane()] : [],
    });
    image_url = () => undefined;
    parse_scrollback = () => [];
  }
  return { ...actual, loadWasmModule: async () => ({ WasmTmux: FakeCore }) };
});

const SNAPSHOT = { url: '/state.bin', session: 'm' };

/** A machine that resets at once: what is under test is what reaches the app. */
class InstantEngine extends GuestEngine {
  send = vi.fn();
  protected async doBoot(): Promise<void> {}
  protected async doReset(): Promise<void> {}
  protected teardown(): void {}
  protected haltMachine(): void {}
  protected continueMachine(): void {}
  currentSink(): EngineSink | null {
    return this.sink;
  }
  /** A state the core streamed, as the resize to the viewport streams them. */
  stream(width: number): void {
    this.sink?.onState({ ...EMPTY_STATE, total_width: width });
  }
}

const shrinkToNothing = backendCall('set_client_size', { cols: 10, rows: 5 });

describe('the first state', () => {
  it('is the one sized to the viewport, not one streamed on the way to it', async () => {
    const engine = new InstantEngine();
    const adapter = new GuestTmuxAdapter(engine, true, SNAPSHOT);
    const widths: number[] = [];
    adapter.events.subscribe((event) => {
      if (event._tag === 'State') widths.push(event.state.total_width);
    });

    await adapter.connect();
    engine.stream(80);
    vi.spyOn(engine, 'resize').mockImplementation(async () => engine.stream(40));
    await adapter.send(backendCall('get_initial_state', { cols: 64, rows: 20 }));
    expect(widths).toEqual([]);

    engine.stream(64);
    expect(widths).toEqual([64]);
  });
});

describe('two stories on one shared guest engine', () => {
  it("leaves the next story's tmux to the next story while the previous app unmounts", async () => {
    const engine = new InstantEngine();
    const resize = vi.spyOn(engine, 'setClientSize');
    const previous = new GuestTmuxAdapter(engine, false, SNAPSHOT);
    const next = new GuestTmuxAdapter(engine, false, SNAPSHOT);

    await previous.connect();
    await previous.send(backendCall('set_client_size', { cols: 40, rows: 30 }));
    expect(resize).toHaveBeenLastCalledWith(40, 30);
    expect(engine.currentSink()).not.toBeNull();

    // From the moment the next story starts, before its reset is done, the
    // previous app's last report (its box shrunk to nothing) goes nowhere and
    // it hears nothing of the next story's machine.
    const connecting = next.connect();
    expect(engine.currentSink()).toBeNull();
    await expect(previous.send(shrinkToNothing)).resolves.toBeNull();
    await connecting;
    await expect(previous.send(shrinkToNothing)).resolves.toBeNull();
    previous.disconnect();

    await next.send(backendCall('set_client_size', { cols: 64, rows: 20 }));
    expect(resize.mock.calls).toEqual([
      [40, 30],
      [64, 20],
    ]);
    expect(engine.currentSink()).not.toBeNull();
  });
});

const ATTACH_LINE = '/tmp/tb/tmux -CC attach -t m\n';
const TIMING: AttachTiming = { attemptMs: 2000, deadlineMs: 10000 };
/** What `tmux -CC` writes the moment its client is attached: the DCS, then
 *  the block answering its own `attach`. */
const ANNOUNCED = '\x1bP1000p%begin 1700000000 263 0\n%end 1700000000 263 0\n';
const FIRST_LAYOUT = '%layout-change @0 b25d,80x30,0,0,0 b25d,80x30,0,0,0 *\n';
const CORE_ATTACH = ['refresh-client -C 80x30', 'list-windows'];

/** A machine whose serial line the test writes: `typed` is what the engine
 *  typed into it, `says` is what the guest prints back. */
class ScriptedGuest extends GuestEngine {
  readonly typed: string[] = [];
  protected haltMachine(): void {}
  protected continueMachine(): void {}
  send(cmd: string): void {
    this.typed.push(cmd);
  }
  protected async doBoot(snapshot: GuestSnapshot, initCommands: string[]): Promise<void> {
    await this.freshCore(snapshot.session);
    await this.start(initCommands, ATTACH_LINE, TIMING);
  }
  protected doReset(snapshot: GuestSnapshot, initCommands: string[]): Promise<void> {
    // A rewound machine's tmux has no control client until one attaches again.
    this.attached = false;
    return this.doBoot(snapshot, initCommands);
  }
  protected teardown(): void {}
  says(text: string): void {
    this.receive(text);
  }
  attachLines(): number {
    return this.typed.filter((line) => line === ATTACH_LINE).length;
  }
}

function freshGuest(): ScriptedGuest {
  vi.useFakeTimers();
  wasm.fed.length = 0;
  wasm.sized.length = 0;
  wasm.resyncs = 0;
  wasm.asked.length = 0;
  return new ScriptedGuest();
}

describe("the guest's attach", () => {
  let guest: ScriptedGuest;
  beforeEach(() => {
    guest = freshGuest();
  });
  afterEach(() => {
    guest.destroy();
    vi.useRealTimers();
  });

  it("holds the core's commands until the guest's tmux announces its control client", async () => {
    const started = guest.boot(SNAPSHOT, ['init']);
    await vi.advanceTimersByTimeAsync(0);
    expect(guest.typed).toEqual([ATTACH_LINE]);

    // The serial shell echoes the line and the kernel is slow to start tmux:
    // nothing it prints is a control client, and none of it reaches the core.
    guest.says('/tmp/tb/tmux -CC attach -t m\r\n');
    await vi.advanceTimersByTimeAsync(1500);
    guest.says('~% ');
    expect(guest.typed).toEqual([ATTACH_LINE]);

    // The DCS split across two reads of the UART still counts.
    guest.says(ANNOUNCED.slice(0, 4));
    expect(guest.typed).toEqual([ATTACH_LINE]);
    guest.says(ANNOUNCED.slice(4));
    await vi.advanceTimersByTimeAsync(0);
    // The init just ahead of the core's attach, so its lists hold what it made.
    expect(guest.typed).toEqual([ATTACH_LINE, 'init', ...CORE_ATTACH]);
    expect(wasm.fed.join('')).toBe(ANNOUNCED.slice('\x1bP1000p'.length));

    guest.says(FIRST_LAYOUT);
    await started;
    expect(guest.typed).toEqual([ATTACH_LINE, 'init', ...CORE_ATTACH]);
  });

  it("sends the init once, though the core's attach goes again to a guest slow to answer it", async () => {
    const started = guest.boot(SNAPSHOT, ['init']);
    await vi.advanceTimersByTimeAsync(0);
    guest.says(ANNOUNCED);
    await vi.advanceTimersByTimeAsync(TIMING.attemptMs);
    guest.says(FIRST_LAYOUT);
    await started;
    expect(guest.typed).toEqual([ATTACH_LINE, 'init', ...CORE_ATTACH, ...CORE_ATTACH]);
  });

  it('types the attach line again into a guest that stays silent', async () => {
    void guest.boot(SNAPSHOT, []);
    await vi.advanceTimersByTimeAsync(TIMING.attemptMs - 1);
    expect(guest.typed).toEqual([ATTACH_LINE]);
    await vi.advanceTimersByTimeAsync(1);
    expect(guest.typed).toEqual([ATTACH_LINE, ATTACH_LINE]);
  });

  it('starts cleanly when the first line was only slow and the second lands in the live client', async () => {
    const started = guest.boot(SNAPSHOT, ['init']);
    await vi.advanceTimersByTimeAsync(TIMING.attemptMs);
    expect(guest.attachLines()).toBe(2);

    // The first line's client announces itself; the second line reached it
    // before any of the core's commands, so tmux refuses it first.
    guest.says(ANNOUNCED);
    guest.says(
      '%begin 1700000000 264 1\nparse error: unknown command: /tmp/tb/tmux\n%error 1700000000 264 1\n',
    );
    await vi.advanceTimersByTimeAsync(0);
    guest.says(FIRST_LAYOUT);
    await started;
    await vi.advanceTimersByTimeAsync(TIMING.deadlineMs);

    expect(guest.typed).toEqual([ATTACH_LINE, ATTACH_LINE, 'init', ...CORE_ATTACH]);
  });

  it('gives up at the deadline when the guest never answers', async () => {
    const started = guest.boot(SNAPSHOT, ['init']);
    const outcome = started.then(
      () => 'started',
      (err: Error) => err.message,
    );
    await vi.advanceTimersByTimeAsync(TIMING.deadlineMs);
    expect(await outcome).toMatch(/did not answer/);
    expect(guest.attachLines()).toBe(TIMING.deadlineMs / TIMING.attemptMs);
    expect(guest.typed).not.toContain('init');

    await vi.advanceTimersByTimeAsync(TIMING.deadlineMs);
    expect(guest.attachLines()).toBe(TIMING.deadlineMs / TIMING.attemptMs);
  });
});

const at = (cols: number, rows: number) => backendCall('set_client_size', { cols, rows });
const firstFetch = (cols: number, rows: number) => backendCall('get_initial_state', { cols, rows });

describe('the size the guest attaches at', () => {
  let guest: ScriptedGuest;
  beforeEach(() => {
    guest = freshGuest();
  });
  afterEach(() => {
    guest.destroy();
    vi.useRealTimers();
  });

  /** The guest's tmux attaching the control client the start typed for. */
  async function answerTheAttach(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    guest.says(ANNOUNCED);
    await vi.advanceTimersByTimeAsync(0);
    guest.says(FIRST_LAYOUT);
  }
  /** The sizes the core's attach commands asked tmux for, in order. */
  const attachedAt = () => guest.typed.filter((line) => line.startsWith('refresh-client -C'));

  it("is the app's viewport, reported while the machine boots, and the first fetch at it is the attach's state as it is", async () => {
    const adapter = new GuestTmuxAdapter(guest, true, SNAPSHOT);
    const connected = adapter.connect();
    await vi.advanceTimersByTimeAsync(0);
    await adapter.send(at(150, 40));
    // Nothing reaches the guest's shell but the attach line.
    expect(guest.typed).toEqual([ATTACH_LINE]);

    await answerTheAttach();
    await connected;
    expect(attachedAt()).toEqual(['refresh-client -C 150x40']);

    const state = (await adapter.send(firstFetch(150, 40))) as { panes: unknown[] };
    expect(state.panes).toHaveLength(1);
    // Neither a resize nor a re-sync and its barrier: only the attach's own sizing.
    expect(wasm.sized).toEqual([[150, 40]]);
    expect(wasm.resyncs).toBe(0);
    expect(wasm.asked).toEqual([]);
  });

  it('is the viewport reported before the adapter even started', async () => {
    const adapter = new GuestTmuxAdapter(guest, true, SNAPSHOT);
    await expect(adapter.send(at(150, 40))).resolves.toBeNull();
    const connected = adapter.connect();
    await answerTheAttach();
    await connected;
    expect(attachedAt()).toEqual(['refresh-client -C 150x40']);
  });

  it('is the default when no viewport came in time, and the first fetch resizes and waits for tmux', async () => {
    const adapter = new GuestTmuxAdapter(guest, true, SNAPSHOT);
    const connected = adapter.connect();
    await answerTheAttach();
    await connected;
    expect(attachedAt()).toEqual(['refresh-client -C 80x30']);

    await adapter.send(firstFetch(150, 40));
    expect(wasm.sized).toEqual([
      [80, 30],
      [150, 40],
    ]);
    expect(wasm.resyncs).toBe(1);
    expect(wasm.asked).toEqual(['display-message -p synced']);
  });

  it('is waited for again when the viewport changes after the attach', async () => {
    const adapter = new GuestTmuxAdapter(guest, true, SNAPSHOT);
    const connected = adapter.connect();
    await adapter.send(at(150, 40));
    await vi.advanceTimersByTimeAsync(0);
    guest.says(ANNOUNCED);
    await vi.advanceTimersByTimeAsync(0);
    await adapter.send(at(120, 40));
    guest.says(FIRST_LAYOUT);
    await connected;

    await adapter.send(firstFetch(120, 40));
    expect(wasm.sized[wasm.sized.length - 1]).toEqual([120, 40]);
    expect(wasm.asked).toEqual(['display-message -p synced']);
  });

  it("holds an init's layout, run ahead of the core's attach, with no barrier at the first fetch", async () => {
    const adapter = new GuestTmuxAdapter(guest, true, SNAPSHOT, { initCommands: ['splitw'] });
    const connected = adapter.connect();
    await adapter.send(at(150, 40));
    await answerTheAttach();
    await connected;
    expect(guest.typed).toEqual([
      ATTACH_LINE,
      'splitw',
      'refresh-client -C 150x40',
      'list-windows',
    ]);

    await adapter.send(firstFetch(150, 40));
    expect(wasm.resyncs).toBe(0);
    expect(wasm.asked).toEqual([]);
  });

  it("is never the previous story's on a shared engine", async () => {
    const previous = new GuestTmuxAdapter(guest, false, SNAPSHOT);
    const next = new GuestTmuxAdapter(guest, false, SNAPSHOT);
    const first = previous.connect();
    await previous.send(at(150, 40));
    await answerTheAttach();
    await first;

    // The next story starts; the previous app, unmounting, reports its box
    // shrunk to nothing, and the next app has measured nothing yet.
    const second = next.connect();
    await previous.send(at(10, 5));
    await answerTheAttach();
    await second;
    expect(attachedAt()).toEqual(['refresh-client -C 150x40', 'refresh-client -C 80x30']);
  });
});
