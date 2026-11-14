/**
 * A jump number: always in the DOM, shown by CSS only while its chord is
 * held (`machines/actors/jumpHintsActor.ts`), so holding a modifier renders
 * nothing. A tab's is its strip position (ctrl+N), a pane's its place in
 * reading order (ctrl+alt+N).
 */

import { useAppSelector } from '../machines/appHooks';
import { selectPaneJumpOrder } from '../machines/selectors/panesAndSidebars';
import { JUMP_HINT_LIMIT } from '../domain/jumpHints';
import type { PaneId } from '../domain/ids';
import './JumpHint.css';

export function TabJumpHint({ position }: { position: number }) {
  if (position < 1 || position > JUMP_HINT_LIMIT) return null;
  return (
    <span className="jump-hint jump-hint-tab" data-jump-hint={position} aria-hidden="true">
      {position}
    </span>
  );
}

export function PaneJumpHint({ paneId }: { paneId: PaneId }) {
  const position = useAppSelector((ctx) => selectPaneJumpOrder(ctx).indexOf(paneId) + 1);
  if (position < 1) return null;
  return (
    <span className="jump-hint jump-hint-pane" data-jump-hint={position} aria-hidden="true">
      {position}
    </span>
  );
}
