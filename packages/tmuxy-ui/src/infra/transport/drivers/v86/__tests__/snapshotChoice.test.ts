import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestEngine } from '../../guest/GuestEngine';
import { V86TmuxAdapter } from '../V86TmuxAdapter';
import { attachLine } from '../v86Guest';

const { fetched, restored } = vi.hoisted(() => ({
  fetched: [] as string[],
  restored: [] as string[],
}));

// A machine with nothing in it, whose states are their own URLs: what is
// under test is which state a start is handed and which session it attaches.
vi.mock('../v86Guest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../v86Guest')>()),
  createV86Emulator: async () => ({
    emu: {
      add_listener: () => {},
      serial0_send: () => {},
      run: async () => {},
      destroy: async () => {},
    },
    loaded: Promise.resolve(),
  }),
  fetchGuestSnapshot: async (url: string) => {
    fetched.push(url);
    return new TextEncoder().encode(url).buffer;
  },
  restoreSnapshot: async (_emu: unknown, bytes: ArrayBuffer) => {
    restored.push(new TextDecoder().decode(bytes));
  },
}));

/** The attach and the wasm core, which need a guest that answers. */
interface Attach {
  start(initCommands: string[], attachLine: string | null): Promise<void>;
  freshCore(session: string): Promise<void>;
}
const attach = GuestEngine.prototype as unknown as Attach;
const start = vi.spyOn(attach, 'start').mockResolvedValue();
const freshCore = vi.spyOn(attach, 'freshCore').mockResolvedValue();

const GENERIC = '/v86-img/tmux-state.bin.zst';
const DEMO = '/v86-img/demo-state.bin.zst';

async function connectAndLeave(adapter: V86TmuxAdapter): Promise<void> {
  await adapter.connect();
  adapter.disconnect();
}

beforeEach(() => {
  fetched.length = 0;
  restored.length = 0;
  start.mockClear();
  freshCore.mockClear();
});

describe('the state a v86 start restores', () => {
  it("is the one the adapter names, attached at that state's session", async () => {
    await connectAndLeave(new V86TmuxAdapter({ snapshot: 'demo' }));
    await connectAndLeave(new V86TmuxAdapter());

    expect(restored).toEqual([DEMO, GENERIC]);
    expect(freshCore.mock.calls).toEqual([['tmuxy'], ['m']]);
    expect(start.mock.calls.map(([, line]) => line)).toEqual([
      attachLine('tmuxy'),
      attachLine('m'),
    ]);
  });

  it('is the one each story names on a shared engine, each fetched once', async () => {
    for (const snapshot of ['generic', 'demo', 'generic', 'demo'] as const) {
      await connectAndLeave(new V86TmuxAdapter({ shared: true, snapshot }));
    }

    expect(restored).toEqual([GENERIC, DEMO, GENERIC, DEMO]);
    expect(fetched).toEqual([GENERIC, DEMO]);
    expect(start.mock.calls.map(([, line]) => line)).toEqual(
      ['m', 'tmuxy', 'm', 'tmuxy'].map(attachLine),
    );
  });
});
