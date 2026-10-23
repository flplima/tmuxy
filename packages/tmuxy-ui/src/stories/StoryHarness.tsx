/**
 * The v86 story harness: the whole app over real tmux in an in-browser x86
 * emulator. The deterministic stories replay recordings instead
 * (`FixtureHarness.tsx`).
 */

import { useMemo } from 'react';
import { TmuxyProvider, TmuxyApp, V86TmuxAdapter, GuestTransportLive } from '../lib';
import { useGridBox } from './gridBox';
import {
  GUEST_DEFAULT_COLS,
  GUEST_DEFAULT_ROWS,
} from '../infra/transport/drivers/guest/GuestEngine';

/**
 * Renders the full TmuxyApp against REAL tmux — running inside a v86 x86
 * emulator, parsed by the tmuxy-core Rust engine compiled to WASM. No lifo.sh,
 * no simulation. Boots from a pre-restored snapshot (~4s); browser-only, so
 * these stories are `v86`-tagged and excluded from the deterministic CI probe.
 *
 * Sized in CELLS rather than pixels, defaulting to a plain 80x30 terminal — the
 * size the guest's tmux is actually running at is what these stories assert
 * against (pane geometry, wrapping, captures), so it is the thing worth pinning,
 * and pinning it keeps every story comparable regardless of the host's font.
 */
export function V86AppHarness({
  initCommands,
  cols = GUEST_DEFAULT_COLS,
  rows = GUEST_DEFAULT_ROWS,
  shared = false,
}: {
  initCommands?: string[];
  /** Terminal width in columns. */
  cols?: number;
  /** Terminal height in rows. */
  rows?: number;
  /** Reuse one process-wide v86 engine across stories (fast snapshot-restore
   *  between stories) instead of cold-booting a private engine per story. */
  shared?: boolean;
}) {
  const transport = useMemo(
    () => GuestTransportLive(new V86TmuxAdapter({ initCommands, shared })),
    [initCommands, shared],
  );
  const box = useGridBox(cols, rows);
  if (!box) return null;
  return (
    <div
      style={{
        height: box.height,
        width: box.width,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        // The theme's window background, as the page root paints it, so the
        // chrome around the panes shows the colour the app gives it.
        background: 'rgb(var(--window-bg-rgb))',
      }}
    >
      <TmuxyProvider transport={transport}>
        <TmuxyApp />
      </TmuxyProvider>
    </div>
  );
}
