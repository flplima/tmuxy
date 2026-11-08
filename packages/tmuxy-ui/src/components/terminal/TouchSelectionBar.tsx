/** A phone has no right click and no `y`: these buttons end a hold's selection. */

import { useCallback } from 'react';
import { useAppSend } from '../../machines/appHooks';
import { extractSelectedText, type CopyModeState } from '../../domain/copyMode';
import { writeClipboard } from '../../infra/clipboard';
import type { PaneId } from '../../domain/ids';
import './TouchSelectionBar.css';

export function TouchSelectionBar({
  paneId,
  copyState,
}: {
  paneId: PaneId;
  copyState: CopyModeState;
}) {
  const send = useAppSend();
  const copy = useCallback(() => {
    void writeClipboard(extractSelectedText(copyState), paneId);
    send({ type: 'COPY_MODE_MOUSE_COPY', paneId });
  }, [send, paneId, copyState]);
  const cancel = useCallback(() => send({ type: 'EXIT_COPY_MODE', paneId }), [send, paneId]);

  return (
    <div className="touch-selection-bar" role="toolbar" aria-label="Selection">
      <button
        type="button"
        className="touch-selection-button"
        data-touch-selection="copy"
        onPointerDown={(e) => e.preventDefault()}
        onClick={copy}
      >
        Copy
      </button>
      <button
        type="button"
        className="touch-selection-button"
        data-touch-selection="cancel"
        onPointerDown={(e) => e.preventDefault()}
        onClick={cancel}
      >
        Cancel
      </button>
    </div>
  );
}
