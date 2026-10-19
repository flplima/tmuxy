/**
 * TerminalPaneScroll — scroll container synchronization, native wheel/touch
 * listeners, and scroll position indicator for TerminalPane.
 */

import type { useCopyModeState } from '../machines/appHooks';

type CopyModeState = NonNullable<ReturnType<typeof useCopyModeState>>;

export function ScrollPositionIndicator({
  indicatorRef,
  copyState,
  paneHeight,
}: {
  indicatorRef: React.RefObject<HTMLDivElement | null>;
  copyState: CopyModeState;
  paneHeight: number;
}) {
  // Scroll indicator geometry (only meaningful in copy mode)
  const totalLines = copyState.totalLines;
  const scrollTop = copyState.scrollTop;
  const thumbPct = totalLines > 0 ? Math.max(5, (paneHeight / totalLines) * 100) : 100;
  const maxScroll = totalLines - paneHeight;
  const thumbTopPct = maxScroll > 0 ? (scrollTop / maxScroll) * (100 - thumbPct) : 0;

  return (
    <div
      ref={indicatorRef}
      style={{
        position: 'absolute',
        right: 3,
        top: `calc(4px + (100% - 8px) * ${thumbTopPct / 100})`,
        width: 7,
        minHeight: 30,
        height: `calc((100% - 8px) * ${thumbPct / 100})`,
        backgroundColor: 'rgba(255, 255, 255, 0.4)',
        borderRadius: 'var(--radius-lg)',
        opacity: 0,
        transition: 'opacity 300ms ease-out',
        pointerEvents: 'none',
        zIndex: 5,
      }}
    />
  );
}
