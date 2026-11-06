/**
 * The app menu bar is rebuilt from several places (a debounced spec change,
 * window focus, a colour-scheme change) and the builds overlap. The slower,
 * older build used to be the one that landed last, leaving stale check
 * marks and disabled states on the bar until the next rebuild.
 */
import { describe, it, expect, vi } from 'vitest';
import type { MenuSpec } from '../../../domain/menus/spec';

type Deferred = { resolve: () => void };
/** One per MenuItem.new, in call order; each resolves when told to. */
const itemBuilds: Deferred[] = [];
const bars: string[] = [];
const closed: string[] = [];

vi.mock('@tauri-apps/api/menu', () => ({
  MenuItem: {
    new: (options: { text: string }) =>
      new Promise((resolve) => {
        itemBuilds.push({ resolve: () => resolve({ text: options.text }) });
      }),
  },
  Menu: {
    new: async (options: { items: Array<{ text: string }> }) => {
      const name = options.items.map((i) => i.text).join(',');
      return {
        setAsAppMenu: async () => {
          bars.push(name);
        },
        close: async () => {
          closed.push(name);
        },
      };
    },
  },
}));

const { setNativeAppMenu } = await import('../nativeMenu');

const spec = (label: string): MenuSpec<string> => [
  { kind: 'item', id: 'one', label, action: 'one' },
];
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('setNativeAppMenu', () => {
  it('an older build overtaken by a newer one never becomes the bar', async () => {
    const dispatch = () => {};
    const older = setNativeAppMenu(spec('older'), dispatch);
    await settle();
    expect(itemBuilds).toHaveLength(1);
    // The older build is still waiting on its items when the newer starts.
    const newer = setNativeAppMenu(spec('newer'), dispatch);
    await settle();
    expect(itemBuilds).toHaveLength(2);

    // The newer build finishes first, the older one after it.
    itemBuilds[1].resolve();
    await newer;
    itemBuilds[0].resolve();
    await older;

    expect(bars).toEqual(['newer']);
    expect(closed).toEqual(['older']);
  });
});
