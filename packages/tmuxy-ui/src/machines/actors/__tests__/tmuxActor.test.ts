import { describe, it, expect, vi } from 'vitest';
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import { createTmuxActor } from '../tmuxActor';
import type { BackendCall } from '../../../domain/backendCalls';
import type { AppRuntime } from '../../../infra/runtime';
import { fakeTransport } from '../../../test/transport';

function spawnTmuxActor(runtime: AppRuntime) {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const tmuxActor = createTmuxActor(runtime);
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

/** Resolves once `pred` holds; the test's own timeout is the only limit. */
async function waitFor(pred: () => boolean): Promise<void> {
  while (!pred()) await new Promise((r) => setTimeout(r, 5));
}

describe('tmuxActor — cancellable scrollback', () => {
  it('FETCH_SCROLLBACK_CELLS success sends COPY_MODE_CHUNK_LOADED to parent', async () => {
    const invoke = vi.fn(async ({ cmd }: BackendCall) => {
      if (cmd === 'get_scrollback_cells') {
        return {
          cells: [],
          historySize: 100,
          start: 0,
          end: 10,
          width: 80,
        };
      }
      return null;
    });
    const { runtime } = fakeTransport({ send: (call) => invoke(call) });
    const { actor, events } = spawnTmuxActor(runtime);
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
    const calls: Array<{ start: number; end: number }> = [];
    let firstResolve: ((value: unknown) => void) | null = null;
    const invoke = vi.fn(async ({ cmd, args }: BackendCall): Promise<unknown> => {
      if (cmd !== 'get_scrollback_cells') return null;
      const a = args as { start: number; end: number; paneId: string };
      calls.push({ start: a.start, end: a.end });
      if (calls.length === 1) {
        // Answered only after the second request has gone out.
        return new Promise((resolve) => {
          firstResolve = resolve;
        });
      }
      return {
        cells: [[{ c: 'X' }]],
        historySize: 200,
        start: a.start,
        end: a.end,
        width: 80,
      };
    });

    const { runtime } = fakeTransport({ send: (call) => invoke(call) });
    const { actor, events } = spawnTmuxActor(runtime);

    actor.getSnapshot().children.tmux!.send({
      type: 'FETCH_SCROLLBACK_CELLS',
      paneId: '%1',
      start: 0,
      end: 10,
    });
    // The first fiber has started: it is in the adapter, waiting on the server.
    await waitFor(() => calls.length === 1);
    actor.getSnapshot().children.tmux!.send({
      type: 'FETCH_SCROLLBACK_CELLS',
      paneId: '%1',
      start: 50,
      end: 60,
    });

    await waitFor(() => firstResolve !== null);
    firstResolve!({
      cells: [[{ c: 'STALE' }]],
      historySize: 999,
      start: 0,
      end: 10,
      width: 80,
    });

    await waitFor(() => events.some((e) => e.type === 'COPY_MODE_CHUNK_LOADED'));

    const loaded = events.filter((e) => e.type === 'COPY_MODE_CHUNK_LOADED');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].historySize).toBe(200);
    expect(loaded[0].start).toBe(50);
    actor.stop();
  });

  it('different paneId fetches do NOT interrupt each other', async () => {
    const invoke = vi.fn(async ({ cmd, args }: BackendCall): Promise<unknown> => {
      if (cmd !== 'get_scrollback_cells') return null;
      const a = args as { paneId: string; start: number; end: number };
      return {
        cells: [],
        historySize: a.paneId === '%1' ? 100 : 200,
        start: a.start,
        end: a.end,
        width: 80,
      };
    });
    const { runtime } = fakeTransport({ send: (call) => invoke(call) });
    const { actor, events } = spawnTmuxActor(runtime);

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

  it('fetch failure tells the parent the chunk failed, never a TMUX_ERROR', async () => {
    // `%1` is gone; `%2` answers. The failure is sent first, and what it did
    // or did not send the parent is read once the second fetch — which it
    // does not interrupt, being another pane's — has landed behind it.
    const invoke = vi.fn(async ({ cmd, args }: BackendCall): Promise<unknown> => {
      if (cmd !== 'get_scrollback_cells') return null;
      const a = args as { paneId: string; start: number; end: number };
      if (a.paneId === '%1') throw { error: 'pane gone', kind: 'tmux' };
      return { cells: [], historySize: 100, start: a.start, end: a.end, width: 80 };
    });
    const { runtime } = fakeTransport({ send: (call) => invoke(call) });
    const { actor, events } = spawnTmuxActor(runtime);
    actor
      .getSnapshot()
      .children.tmux!.send({ type: 'FETCH_SCROLLBACK_CELLS', paneId: '%1', start: 0, end: 10 });
    actor
      .getSnapshot()
      .children.tmux!.send({ type: 'FETCH_SCROLLBACK_CELLS', paneId: '%2', start: 0, end: 10 });
    await waitFor(() => events.some((e) => e.type === 'COPY_MODE_CHUNK_LOADED'));

    const tmuxErrors = events.filter((e) => e.type === 'TMUX_ERROR');
    const chunks = events.filter((e) => e.type === 'COPY_MODE_CHUNK_LOADED');
    const failed = events.filter((e) => e.type === 'COPY_MODE_CHUNK_FAILED');
    expect(tmuxErrors).toHaveLength(0);
    expect(chunks.map((e) => e.paneId)).toEqual(['%2']);
    expect(failed.map((e) => e.paneId)).toEqual(['%1']);
    actor.stop();
  });
});

describe('tmuxActor — the client size report', () => {
  const report = { type: 'SET_CLIENT_SIZE', cols: 120, rows: 30 } as const;
  const unreported = (events: Array<{ type: string }>) =>
    events.filter((e) => e.type === 'CLIENT_SIZE_UNREPORTED');

  // The app reports a size once, so the actor has to say when the one report
  // was lost: nothing else would send it again.
  it('tells the parent when a report did not reach the backend', async () => {
    const { runtime } = fakeTransport({
      send: async () => {
        throw { error: 'connection reset', kind: 'network' };
      },
    });
    const { actor, events } = spawnTmuxActor(runtime);
    actor.getSnapshot().children.tmux!.send(report);
    await waitFor(() => unreported(events).length > 0);
    expect(unreported(events)).toEqual([{ type: 'CLIENT_SIZE_UNREPORTED', cols: 120, rows: 30 }]);
    actor.stop();
  });

  it('says nothing of a report the backend took', async () => {
    const transport = fakeTransport();
    const { actor, events } = spawnTmuxActor(transport.runtime);
    actor.getSnapshot().children.tmux!.send(report);
    await waitFor(() => transport.invocations.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unreported(events)).toEqual([]);
    actor.stop();
  });
});

describe('tmuxActor — switching session', () => {
  it('says when a switch opened a new stream, so its state can be asked for', async () => {
    const switched: string[] = [];
    const { runtime } = fakeTransport({
      switchSession: async (name) => {
        switched.push(name);
      },
    });
    const { actor, events } = spawnTmuxActor(runtime);
    actor.getSnapshot().children.tmux!.send({ type: 'SWITCH_SESSION', sessionName: 'play' });

    await waitFor(() => events.some((e) => e.type === 'TMUX_SESSION_SWITCHED'));
    expect(switched).toEqual(['play']);
    actor.stop();
  });

  // The desktop moves its one client with switch-client and does not wait for
  // it: a fetch then could answer with the session it was leaving.
  it('says nothing when the one client moved instead, as on the desktop', async () => {
    const ran: string[] = [];
    const { runtime } = fakeTransport({
      send: async (call) => {
        if (call.cmd === 'run_tmux_command') ran.push(call.args.command);
        return null;
      },
    });
    const { actor, events } = spawnTmuxActor(runtime);
    actor.getSnapshot().children.tmux!.send({ type: 'SWITCH_SESSION', sessionName: 'play' });

    await waitFor(() => ran.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(ran[0]).toContain('switch-client');
    expect(events.some((e) => e.type === 'TMUX_SESSION_SWITCHED')).toBe(false);
    actor.stop();
  });
});
