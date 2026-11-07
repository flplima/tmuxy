import { describe, expect, it } from 'vitest';
import { restoreSnapshot, type V86Emulator } from '../v86Guest';

const U64 = (1n << 64n) - 1n;
const SAVED_TSC = 99_260_000_000n;

/**
 * v86's TSC as its `cpu.rs` computes it, in wrapping u64: `read_tsc` is the
 * host clock less `tsc_offset`, and `set_tsc` sets the offset to
 * `read_tsc() - value`, which is the right offset only while it is zero.
 * `restore_state` sets the saved TSC that way.
 */
function fakeEmulator() {
  let host = 5_000_000_000n;
  let offset = 0n;
  const readTsc = () => (host - offset) & U64;
  const setTsc = (value: bigint) => {
    offset = (readTsc() - value) & U64;
  };
  const current = new Uint32Array(2);
  const emu = {
    v86: {
      cpu: {
        current_tsc: current,
        store_current_tsc: () => {
          const tsc = readTsc();
          current[0] = Number(tsc & 0xffffffffn);
          current[1] = Number(tsc >> 32n);
        },
        set_tsc: (low: number, high: number) => setTsc(BigInt(low) | (BigInt(high) << 32n)),
      },
    },
    restore_state: async () => setTsc(SAVED_TSC),
  } as unknown as V86Emulator;
  return { emu, readTsc, elapse: (ns: bigint) => (host += ns) };
}

describe('restoreSnapshot', () => {
  it('puts the guest TSC back at the saved value on every restore of one emulator', async () => {
    const { emu, readTsc, elapse } = fakeEmulator();
    for (let restore = 0; restore < 4; restore++) {
      await restoreSnapshot(emu, new ArrayBuffer(0));
      expect(readTsc()).toBe(SAVED_TSC);
      elapse(13_000_000_000n);
    }
  });
});
