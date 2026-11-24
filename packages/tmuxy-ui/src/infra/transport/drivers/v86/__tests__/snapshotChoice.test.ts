import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestEngine } from '../../guest/GuestEngine';
import { V86TmuxAdapter } from '../V86TmuxAdapter';
import { attachLine } from '../v86Guest';

const { asked } = vi.hoisted(() => ({ asked: [] as string[] }));

// Machines with nothing in them: what is under test is which state a start
// asks its machine for. Fetching and keeping each state is the machine
// worker's (machineHost.test.ts).
vi.mock('../machine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../machine')>()),
  spawnV86Machine: () => ({
    boot: async (url: string) => void asked.push(`boot ${url}`),
    restore: async (url: string) => void asked.push(`restore ${url}`),
    write: () => {},
    watchScreen: () => {},
    destroy: () => {},
  }),
}));

/** The attach and the wasm core, which need a guest that answers. */
interface Attach {
  start(initCommands: string[], attachLine: string): Promise<void>;
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
  asked.length = 0;
  start.mockClear();
  freshCore.mockClear();
});

describe('the state a v86 start restores', () => {
  it("is the one the adapter names, attached at that state's session", async () => {
    await connectAndLeave(new V86TmuxAdapter({ snapshot: 'demo' }));
    await connectAndLeave(new V86TmuxAdapter());

    expect(asked).toEqual([`boot ${DEMO}`, `boot ${GENERIC}`]);
    expect(freshCore.mock.calls).toEqual([['tmuxy'], ['m']]);
    expect(start.mock.calls.map(([, line]) => line)).toEqual([
      attachLine('tmuxy'),
      attachLine('m'),
    ]);
  });

  it('is the one each story names on a shared engine, which keeps its machine', async () => {
    for (const snapshot of ['generic', 'demo', 'generic', 'demo'] as const) {
      await connectAndLeave(new V86TmuxAdapter({ shared: true, snapshot }));
    }

    expect(asked).toEqual([
      `boot ${GENERIC}`,
      `restore ${DEMO}`,
      `restore ${GENERIC}`,
      `restore ${DEMO}`,
    ]);
    expect(start.mock.calls.map(([, line]) => line)).toEqual(
      ['m', 'tmuxy', 'm', 'tmuxy'].map(attachLine),
    );
  });
});
