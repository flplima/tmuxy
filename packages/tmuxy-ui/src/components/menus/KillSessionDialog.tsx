import { createPortal } from 'react-dom';
import { Modal } from '../Modal';

/** Kill Session's confirmation: it ends everything running in the session. */
export function KillSessionDialog({
  sessionName,
  onCancel,
  onKill,
}: {
  sessionName: string;
  onCancel: () => void;
  onKill: () => void;
}) {
  return createPortal(
    <Modal open title="Kill Session" width={360} onClose={onCancel}>
      <p className="app-menu-dialog-text">
        Kill session <strong>{sessionName}</strong>? Every window and pane in it closes, and what is
        running in them is ended.
      </p>
      <div className="app-menu-dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="is-destructive" onClick={onKill}>
          Kill Session
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
