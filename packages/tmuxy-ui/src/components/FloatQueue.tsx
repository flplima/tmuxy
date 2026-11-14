/**
 * The tab's minimized floats, as pills along its bottom edge
 * (`@tmuxy-float-minimized`). Their panes keep running: a dev server or a
 * log tail stays one click away without covering the panes. A click brings
 * the float back, and its ✕ closes it.
 */

import { useAppSend, useAppSelector, usePane } from '../machines/appHooks';
import { selectMinimizedFloats } from '../machines/selectors/panesAndSidebars';
import { getTabText } from './paneTabDisplay';
import { PaneStateMark } from './PaneStateMark';
import { paneStateFor } from '../domain/paneState';
import type { PaneId } from '../domain/ids';
import './FloatQueue.css';

function FloatPill({ paneId }: { paneId: PaneId }) {
  const pane = usePane(paneId);
  const send = useAppSend();
  if (!pane) return null;
  const title = getTabText(pane);
  const state = paneStateFor(pane);
  return (
    <span className="float-queue-pill" data-float-pill={paneId}>
      <button
        type="button"
        className="float-queue-restore"
        aria-label={`Show ${title}`}
        onClick={() => send({ type: 'MINIMIZE_FLOAT', paneId, minimized: false })}
      >
        {state !== 'idle' && <PaneStateMark state={state} className="float-queue-state" />}
        <span className="float-queue-title">{title}</span>
      </button>
      <button
        type="button"
        className="float-queue-close"
        aria-label={`Close ${title}`}
        onClick={() => send({ type: 'CLOSE_FLOAT', paneId })}
      >
        ✕
      </button>
    </span>
  );
}

export function FloatQueue() {
  const minimized = useAppSelector(selectMinimizedFloats);
  if (minimized.length === 0) return null;
  return (
    <div className="float-queue" role="toolbar" aria-label="Minimized floats">
      {minimized.map((float) => (
        <FloatPill key={float.paneId} paneId={float.paneId} />
      ))}
    </div>
  );
}
