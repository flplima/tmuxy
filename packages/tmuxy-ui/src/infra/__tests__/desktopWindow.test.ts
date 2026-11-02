/**
 * Closing a sidebar column within one shell round trip of opening it: the
 * close used to compute its shrink from a growth the open had not recorded
 * yet (it lands when the grow resolves), shrink by nothing, and leave the
 * window a column wider until the next close.
 */
import { describe, it, expect, vi } from 'vitest';

type Deferred = { resolve: (applied: number) => void };
const grows: Array<{ dx: number } & Deferred> = [];
const invoke = vi.fn(
  (_cmd: string, args: { dx: number }) =>
    new Promise<number>((resolve) => {
      grows.push({ dx: args.dx, resolve });
    }),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../utils/platform', () => ({ isTauri: () => true, isMacPlatform: () => false }));

const { fitWindowToSidebar } = await import('../desktopWindow');

/** Let the fit chain's microtasks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('fitWindowToSidebar', () => {
  it('a close before the open has been answered takes back what the open took', async () => {
    fitWindowToSidebar('left', true, 200);
    fitWindowToSidebar('left', false, 200);
    await settle();
    expect(grows.map((g) => g.dx)).toEqual([200]);

    grows[0].resolve(200);
    await settle();
    expect(grows.map((g) => g.dx)).toEqual([200, -200]);

    grows[1].resolve(-200);
    await settle();
    // The books balance: a fresh open asks for the whole column again.
    fitWindowToSidebar('left', true, 200);
    await settle();
    expect(grows.map((g) => g.dx)).toEqual([200, -200, 200]);
  });
});
