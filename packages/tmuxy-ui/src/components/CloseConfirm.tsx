/**
 * The question a close is held for while a pane it would end says it is
 * working or waiting for the user (`domain/closeGuard.ts`). The keyboard
 * answers too: Enter closes, Escape keeps (`machines/actors/keyboardActor`).
 */

import { useAppSend, useAppSelector } from '../machines/appHooks';
import { BUSY_PANE_STATE_PHRASE } from '../domain/paneState';
import type { PendingClose } from '../domain/closeGuard';
import { Modal } from './Modal';
import './menus/AppMenu.css';

const TITLE: Record<PendingClose['scope'], string> = {
  pane: 'Close Pane',
  tab: 'Close Tab',
  several: 'Close Panes',
};

function question({ scope, busy }: PendingClose): string {
  if (scope === 'pane') return 'Close this pane?';
  if (scope === 'several') return 'This closes panes that are busy. Go on?';
  return busy.length === 1
    ? 'Close this tab?'
    : `Close this tab and its ${busy.length} busy panes?`;
}

export function CloseConfirm() {
  const pending = useAppSelector((ctx) => ctx.pendingClose);
  const send = useAppSend();
  if (!pending) return null;

  const cancel = () => send({ type: 'CANCEL_CLOSE' });
  const title = TITLE[pending.scope];
  return (
    <Modal open title={title} width={380} onClose={cancel}>
      <div data-testid="close-confirm" role="alertdialog" aria-label={title}>
        <p className="app-menu-dialog-text">{question(pending)}</p>
        <p className="app-menu-dialog-text">
          {pending.busy.map((pane) => (
            <span key={pane.paneId} data-close-confirm-pane={pane.paneId}>
              <strong>{pane.command}</strong> is {BUSY_PANE_STATE_PHRASE[pane.state] ?? 'busy'}
              .{' '}
            </span>
          ))}
          What is running there is ended.
        </p>
        <div className="app-menu-dialog-actions">
          <button type="button" data-close-confirm="cancel" onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="is-destructive"
            data-close-confirm="close"
            onClick={() => send({ type: 'CONFIRM_CLOSE' })}
          >
            {title}
          </button>
        </div>
      </div>
    </Modal>
  );
}
