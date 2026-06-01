/**
 * DemoAdapter test-mode hooks.
 *
 * The adapter ships three knobs that exist only to make Storybook integration
 * tests deterministic without standing up a real backend:
 *
 *  - `commandDelayMs` lets tests assert optimistic UI stays smooth while the
 *    backend is slow.
 *  - `failCommand` lets tests assert optimistic rollback when tmux rejects.
 *  - `emitClipboard` lets tests round-trip OSC 52 payloads through the
 *    adapter without needing a real OSC 52 emitter.
 *
 * These knobs ship in the production bundle (they're guarded by being opt-in
 * args), so they deserve coverage to catch regressions in either the
 * Promise shape or the listener set.
 */

import { describe, it, expect } from 'vitest';
import { DemoAdapter } from '../DemoAdapter';

describe('DemoAdapter test-mode hooks', () => {
  it('delays run_tmux_command by commandDelayMs', async () => {
    const adapter = new DemoAdapter({ commandDelayMs: 80 });
    await adapter.connect();

    const start = performance.now();
    await adapter.invoke('run_tmux_command', { command: 'split-window -h' });
    const elapsed = performance.now() - start;

    // Allow generous slack for jsdom timer jitter; we only need to confirm
    // the configured delay was applied (not the precise duration).
    expect(elapsed).toBeGreaterThanOrEqual(70);
  });

  it('rejects run_tmux_command with { error } when failCommand returns a string', async () => {
    const adapter = new DemoAdapter({
      failCommand: (cmd) => (cmd.startsWith('split-window') ? 'no space' : false),
    });
    await adapter.connect();

    await expect(
      adapter.invoke('run_tmux_command', { command: 'split-window -h' }),
    ).rejects.toMatchObject({ error: 'no space' });

    // Non-failing commands still resolve.
    await expect(
      adapter.invoke('run_tmux_command', { command: 'select-pane -t %0' }),
    ).resolves.toBeNull();
  });

  it('emitClipboard fans out to onClipboard listeners', async () => {
    const adapter = new DemoAdapter();
    await adapter.connect();

    const seen: Array<[string, string]> = [];
    const unsub = adapter.onClipboard!((paneId, text) => seen.push([paneId, text]));

    adapter.emitClipboard('%3', 'pasted via OSC 52');
    expect(seen).toEqual([['%3', 'pasted via OSC 52']]);

    unsub();
    adapter.emitClipboard('%3', 'after unsubscribe');
    expect(seen).toEqual([['%3', 'pasted via OSC 52']]);
  });
});
