/**
 * A desktop window hears its own monitor and no other. Each window's monitor
 * sends its states to that window's label (`emit_to`); Tauri hands an event
 * to every listener that asked for any target, whichever window it was sent
 * to. A second window that listened that way took the first window's
 * states, of another session and another sequence, as its own, and could be
 * left with no pane to show (C12).
 */
import { describe, it, expect, vi } from 'vitest';

type Target = { kind: 'Any' } | { kind: 'AnyLabel'; label: string };
type Listener = { event: string; target: Target; handler: (e: { payload: unknown }) => void };

/** The page's window, and the listeners it has registered. */
const THIS_WINDOW = 'win2';
const listeners: Listener[] = [];

/**
 * Tauri's delivery rule (`event/listener.rs`, `match_any_or_filter`): an
 * any-target listener hears everything; a labelled one, what is sent to its
 * label or to every window.
 */
function emitTo(label: string | null, event: string, payload: unknown): void {
  for (const l of listeners) {
    if (l.event !== event) continue;
    const hears = l.target.kind === 'Any' || label === null || l.target.label === label;
    if (hears) l.handler({ payload });
  }
}

vi.mock('@tauri-apps/api/event', () => ({
  listen: (
    event: string,
    handler: Listener['handler'],
    options?: { target?: string | Target },
  ): Promise<() => void> => {
    const t = options?.target;
    const target: Target =
      typeof t === 'string' ? { kind: 'AnyLabel', label: t } : (t ?? { kind: 'Any' });
    listeners.push({ event, target, handler });
    return Promise.resolve(() => {});
  },
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: THIS_WINDOW }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === 'dispatch' ? [] : null),
}));

const { TauriAdapter } = await import('../TauriAdapter');

describe('TauriAdapter', () => {
  it("hears the state its own window is sent, never another window's", async () => {
    const adapter = new TauriAdapter();
    const heard: unknown[] = [];
    adapter.events.subscribe((e) => {
      if (e._tag === 'StateReceived') heard.push(e.payload);
    });
    await adapter.connect();

    const ours = { type: 'delta', delta: { seq: 4 } };
    const theirs = { type: 'delta', delta: { seq: 18 } };
    emitTo('main', 'state-update', theirs);
    emitTo(THIS_WINDOW, 'state-update', ours);

    expect(heard).toEqual([ours]);
  });
});
