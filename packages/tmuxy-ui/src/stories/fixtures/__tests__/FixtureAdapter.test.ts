/**
 * The fixture adapter's promises to a story: a scripted command answers with
 * the recorded state it names, nothing else changes the state, and the
 * delay and refusal knobs behave as a slow or refusing tmux would.
 */

import { describe, it, expect } from 'vitest';
import { pid } from '../../../test/wire';
import { FixtureAdapter, asFixture } from '../FixtureAdapter';
import panes from '../gen/panes.json';

const fixture = asFixture(panes);

/** Pane ids in each state the adapter emits, in order. */
function emittedPanes(adapter: FixtureAdapter): string[][] {
  const seen: string[][] = [];
  adapter.events.subscribe((event) => {
    if (event._tag === 'State') seen.push(event.state.panes.map((p) => p.tmux_id as string).sort());
  });
  return seen;
}

describe('FixtureAdapter', () => {
  it('starts in its recorded state and answers a scripted command with the state it names', async () => {
    const adapter = new FixtureAdapter({
      fixture,
      start: 'one',
      transitions: [{ match: /^split-window\b/, to: 'side-by-side' }],
    });
    const seen = emittedPanes(adapter);
    await adapter.connect();
    const initial = (await adapter.send({
      cmd: 'get_initial_state',
      args: { cols: 80, rows: 24 },
    })) as { panes: unknown[] };
    expect(initial.panes).toHaveLength(1);

    await adapter.send({ cmd: 'run_tmux_command', args: { command: 'split-window -h' } });
    expect(seen).toEqual([['%0', '%1']]);
    // An unscripted command is accepted and changes nothing.
    await adapter.send({ cmd: 'run_tmux_command', args: { command: 'select-pane -t %0' } });
    expect(seen).toEqual([['%0', '%1']]);
    expect(adapter.commands).toEqual(['split-window -h', 'select-pane -t %0']);
  });

  it('a transition with `from` answers only in that state, so a toggle goes both ways', async () => {
    const adapter = new FixtureAdapter({
      fixture,
      start: 'one',
      transitions: [
        { match: /^toggle$/, from: 'one', to: 'side-by-side' },
        { match: /^toggle$/, from: 'side-by-side', to: 'one' },
      ],
    });
    const seen = emittedPanes(adapter);
    await adapter.send({ cmd: 'run_tmux_command', args: { command: 'toggle' } });
    await adapter.send({ cmd: 'run_tmux_command', args: { command: 'toggle' } });
    expect(seen).toEqual([['%0', '%1'], ['%0']]);
  });

  it('refuses a recorded state it does not have, naming the ones it does', () => {
    expect(() => new FixtureAdapter({ fixture, start: 'nope' })).toThrow(
      /one, side-by-side, three/,
    );
  });

  it('delays every command by commandDelayMs', async () => {
    const adapter = new FixtureAdapter({ fixture, start: 'one', commandDelayMs: 80 });
    const start = performance.now();
    await adapter.send({ cmd: 'run_tmux_command', args: { command: 'split-window -h' } });
    // Generous slack for timer jitter: only that the delay applied matters.
    expect(performance.now() - start).toBeGreaterThanOrEqual(70);
  });

  it('refuses a command as tmux does (kind tmux) when failCommand names a reason', async () => {
    const adapter = new FixtureAdapter({
      fixture,
      start: 'one',
      transitions: [{ match: /^split-window\b/, to: 'side-by-side' }],
      failCommand: (cmd) => (cmd.startsWith('split-window') ? 'no space' : false),
    });
    const seen = emittedPanes(adapter);
    await expect(
      adapter.send({ cmd: 'run_tmux_command', args: { command: 'split-window -h' } }),
    ).rejects.toMatchObject({ error: 'no space', kind: 'tmux' });
    // A refused command moves nothing.
    expect(seen).toEqual([]);
    await expect(
      adapter.send({ cmd: 'run_tmux_command', args: { command: 'select-pane -t %0' } }),
    ).resolves.toBeNull();
  });

  it('emitClipboard reaches the subscribers there are', () => {
    const adapter = new FixtureAdapter({ fixture, start: 'one' });
    const seen: Array<[string | null, string]> = [];
    const unsubscribe = adapter.events.subscribe((event) => {
      if (event._tag === 'Clipboard') seen.push([event.paneId, event.text]);
    });
    adapter.emitClipboard(pid('%3'), 'pasted via OSC 52');
    unsubscribe();
    adapter.emitClipboard(pid('%3'), 'after unsubscribe');
    expect(seen).toEqual([[pid('%3'), 'pasted via OSC 52']]);
  });
});
