import { describe, it, expect, vi } from 'vitest';
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import { createTmuxActor } from '../tmuxActor';
import type { TmuxAdapter } from '../../../tmux/types';

/**
 * Build a minimal TmuxAdapter stub. Tests override individual methods.
 */
function makeStubAdapter(overrides: Partial<TmuxAdapter>): TmuxAdapter {
  const noop = () => {};
  return {
    connect: () => Promise.resolve(),
    disconnect: noop,
    isConnected: () => true,
    isReconnecting: () => false,
    invoke: () => Promise.resolve(undefined as never),
    onStateChange: () => noop,
    onError: () => noop,
    onConnectionInfo: () => noop,
    onReconnection: () => noop,
    onKeyBindings: () => noop,
    onLog: () => noop,
    onFatal: () => noop,
    ...overrides,
  };
}

/**
 * Spawn a tmuxActor as a child of a tiny parent machine and return both.
 * Captures every event the actor sends to the parent in `events`.
 */
function spawnTmuxActor(adapter: TmuxAdapter) {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const tmuxActor = createTmuxActor(adapter);
  const parent = createMachine({
    types: {} as { events: { type: string; [k: string]: unknown } },
    invoke: {
      id: 'tmux',
      src: 'tmuxActor',
      input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
    },
    on: {
      '*': {
        actions: ({ event }) => {
          events.push(event as { type: string; [k: string]: unknown });
        },
      },
    },
  }).provide({
    actors: { tmuxActor },
    // unused, but XState v5 requires `actions` to satisfy provided shapes
    actions: {},
  } as never);
  const actor = createActor(parent);
  actor.start();
  return { actor, events };
}

/** Helper: wait until the predicate is true (or timeout). */
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timeout waiting for predicate');
}

describe('tmuxActor — Phase E4 cancellable scrollback', () => {
  it('FETCH_SCROLLBACK_CELLS success sends COPY_MODE_CHUNK_LOADED to parent', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'get_scrollback_cells') {
        return {
          cells: [],
          historySize: 100,
          start: 0,
          end: 10,
          width: 80,
        };
      }
      return undefined;
    });
    const adapter = makeStubAdapter({ invoke: invoke as TmuxAdapter['invoke'] });
    const { actor, events } = spawnTmuxActor(adapter);
    actor
      .getSnapshot()
      .children.tmux!.send({ type: 'FETCH_SCROLLBACK_CELLS', paneId: '%1', start: 0, end: 10 });

    await waitFor(() => events.some((e) => e.type === 'COPY_MODE_CHUNK_LOADED'));
    const chunk = events.find((e) => e.type === 'COPY_MODE_CHUNK_LOADED')!;
    expect(chunk.paneId).toBe('%1');
    expect(chunk.historySize).toBe(100);
    actor.stop();
  });

  it('interrupts the previous fetch so its result never reaches the parent', async () => {
    // First call: a slow promise that never resolves. Second call: a fast resolution.
    // Confirm the slow one never delivers a COPY_MODE_CHUNK_LOADED — because
    // it was interrupted before it could fire its onSuccess.
    const calls: Array<{ start: number; end: number }> = [];
    let firstResolve: ((value: unknown) => void) | null = null;
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== 'get_scrollback_cells') return undefined;
      const a = args as { start: number; end: number; paneId: string };
      calls.push({ start: a.start, end: a.end });
      if (calls.length === 1) {
        // Slow: pretend the server is taking forever, then "respond" after the
        // second request has fired. By that time our fiber should be interrupted.
        return new Promise((resolve) => {
          firstResolve = resolve;
        });
      }
      // Fast second response.
      return {
        cells: [[{ c: 'X' }]],
        historySize: 200,
        start: a.start,
        end: a.end,
        width: 80,
      };
    });

    const adapter = makeStubAdapter({ invoke: invoke as TmuxAdapter['invoke'] });
    const { actor, events } = spawnTmuxActor(adapter);

    actor.getSnapshot().children.tmux!.send({
      type: 'FETCH_SCROLLBACK_CELLS',
      paneId: '%1',
      start: 0,
      end: 10,
    });
    // tiny tick so the first fiber actually starts
    await new Promise((r) => setTimeout(r, 5));
    actor.getSnapshot().children.tmux!.send({
      type: 'FETCH_SCROLLBACK_CELLS',
      paneId: '%1',
      start: 50,
      end: 60,
    });

    // Now resolve the FIRST call's promise — it would have shipped a stale
    // result if the fiber hadn't been interrupted.
    await waitFor(() => firstResolve !== null);
    firstResolve!({
      cells: [[{ c: 'STALE' }]],
      historySize: 999,
      start: 0,
      end: 10,
      width: 80,
    });

    // Wait until the second call's COPY_MODE_CHUNK_LOADED has fired.
    await waitFor(() => events.some((e) => e.type === 'COPY_MODE_CHUNK_LOADED'));

    const loaded = events.filter((e) => e.type === 'COPY_MODE_CHUNK_LOADED');
    // The fresh request (start:50) should have landed. The stale request's
    // result must NOT appear — because the fiber was interrupted before its
    // onSuccess could run.
    expect(loaded).toHaveLength(1);
    expect(loaded[0].historySize).toBe(200);
    expect(loaded[0].start).toBe(50);
    actor.stop();
  });

  it('different paneId fetches do NOT interrupt each other', async () => {
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== 'get_scrollback_cells') return undefined;
      const a = args as { paneId: string; start: number; end: number };
      return {
        cells: [],
        historySize: a.paneId === '%1' ? 100 : 200,
        start: a.start,
        end: a.end,
        width: 80,
      };
    });
    const adapter = makeStubAdapter({ invoke: invoke as TmuxAdapter['invoke'] });
    const { actor, events } = spawnTmuxActor(adapter);

    actor
      .getSnapshot()
      .children.tmux!.send({ type: 'FETCH_SCROLLBACK_CELLS', paneId: '%1', start: 0, end: 10 });
    actor
      .getSnapshot()
      .children.tmux!.send({ type: 'FETCH_SCROLLBACK_CELLS', paneId: '%2', start: 0, end: 10 });

    await waitFor(() => events.filter((e) => e.type === 'COPY_MODE_CHUNK_LOADED').length === 2);
    const loaded = events.filter((e) => e.type === 'COPY_MODE_CHUNK_LOADED');
    const paneIds = new Set(loaded.map((e) => e.paneId));
    expect(paneIds).toEqual(new Set(['%1', '%2']));
    actor.stop();
  });

  it('fetch failure is silent (no TMUX_ERROR tunneled to parent)', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'get_scrollback_cells') {
        throw { error: 'pane gone' };
      }
      return undefined;
    });
    const adapter = makeStubAdapter({ invoke: invoke as TmuxAdapter['invoke'] });
    const { actor, events } = spawnTmuxActor(adapter);
    actor
      .getSnapshot()
      .children.tmux!.send({ type: 'FETCH_SCROLLBACK_CELLS', paneId: '%1', start: 0, end: 10 });

    // Give time for the fetch to fail
    await new Promise((r) => setTimeout(r, 30));

    const tmuxErrors = events.filter((e) => e.type === 'TMUX_ERROR');
    const chunks = events.filter((e) => e.type === 'COPY_MODE_CHUNK_LOADED');
    expect(tmuxErrors).toHaveLength(0);
    expect(chunks).toHaveLength(0);
    actor.stop();
  });
});
