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
 * Boots from a pre-restored snapshot (~4s); browser-only, so these stories
 * are `v86`-tagged and excluded from the deterministic CI probe.
 *
 * Sized in cells, not pixels: the size the guest's tmux runs at is what these
 * stories assert against, and pinning it keeps every story comparable
 * whatever the host's font.
 */
export function V86AppHarness({
  initCommands,
  initDoneOption,
  cols = GUEST_DEFAULT_COLS,
  rows = GUEST_DEFAULT_ROWS,
  shared = false,
}: {
  initCommands?: string[];
  /** The tmux option the init sets when it is done (`GuestTmuxAdapterOptions`). */
  initDoneOption?: string;
  cols?: number;
  rows?: number;
  /** Reuse one process-wide v86 engine across stories (fast snapshot-restore
   *  between stories) instead of cold-booting a private engine per story. */
  shared?: boolean;
}) {
  const transport = useMemo(
    () => GuestTransportLive(new V86TmuxAdapter({ initCommands, initDoneOption, shared })),
    [initCommands, initDoneOption, shared],
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
        // As the page root paints it (standalone.css).
        background: 'rgb(var(--window-bg-rgb))',
      }}
    >
      <TmuxyProvider transport={transport}>
        <TmuxyApp />
      </TmuxyProvider>
    </div>
  );
}
