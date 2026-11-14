import { memo } from 'react';
import { usePane } from '../machines/appHooks';
import { LogProfiler } from './renderLog';
import { paneWidgetOf } from './widgets/registry';
import { WidgetPane } from './WidgetPane';
import { PaneJumpHint } from './JumpHint';
import { TerminalPane } from './terminal/TerminalPane';
import type { PaneId } from '../domain/ids';

interface PaneProps {
  paneId: PaneId;
}

/**
 * Memoized on paneId: PaneLayout re-renders whenever any pane changes, and
 * without this boundary every pane's subtree re-rendered on every keystroke.
 * usePane still updates it when its own pane changes.
 */
export const Pane = memo(function Pane({ paneId }: PaneProps) {
  const pane = usePane(paneId);
  const widget = paneWidgetOf(pane);

  if (!pane) return null;
  // The Profiler sits INSIDE the memo boundary so a memo bail-out records
  // zero commits — it measures real pane work, not parent churn.
  if (widget) {
    return (
      <LogProfiler id={`Pane:${paneId}`}>
        <WidgetPane paneId={paneId} widget={widget} />
        <PaneJumpHint paneId={paneId} />
      </LogProfiler>
    );
  }
  return (
    <LogProfiler id={`Pane:${paneId}`}>
      <TerminalPane paneId={paneId} />
      <PaneJumpHint paneId={paneId} />
    </LogProfiler>
  );
});
