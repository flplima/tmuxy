import { describe, it, expect, vi } from 'vitest';
import { createActor, type AnyActorRef } from 'xstate';

const invoke = vi.fn(() => Promise.resolve());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../../utils/platform', () => ({ isTauri: () => true }));

const { createGestureActor } = await import('../gestureActor');

/** A parent machine whose context is a tab with a mouse-tracking pane on it. */
function parentWith(swipeTabs: boolean): AnyActorRef {
  const context = {
    activeWindowId: '@1',
    panes: [
      { windowId: '@1', mouseAnyFlag: true },
      { windowId: '@1', mouseAnyFlag: false },
    ],
    gestureFlags: { swipeTabs, pinchZoom: true, pinchOverview: true },
  };
  return {
    send: () => {},
    getSnapshot: () => ({ context }),
    subscribe: () => ({ unsubscribe: () => {} }),
  } as unknown as AnyActorRef;
}

describe('gestureActor', () => {
  it('lets the shell claim a slide on a tab whose program tracks the mouse', () => {
    // Claude Code and nvim track the mouse; gating the slide on them left
    // every tab that had one with no tab switch at all.
    invoke.mockClear();
    const actor = createActor(createGestureActor(), {
      input: { parent: parentWith(true) },
    }).start();
    expect(invoke).toHaveBeenCalledWith('set_swipe_tabs', { enabled: true });
    actor.stop();
  });

  it('tells the shell to claim nothing when the config turns the slide off', () => {
    invoke.mockClear();
    const actor = createActor(createGestureActor(), {
      input: { parent: parentWith(false) },
    }).start();
    expect(invoke).toHaveBeenCalledWith('set_swipe_tabs', { enabled: false });
    actor.stop();
  });
});
