/**
 * OfferBanner — a command a session restore offers to run again, as one line
 * along the bottom of the pane it brought back: `↵ to run: <command> · esc to
 * dismiss`.
 *
 * The restore does not type the command (it would race the shell's start-up
 * and show twice) and does not run it (a program that was running is not
 * proof it should run again). It hangs it on the pane as an `@tmuxy-ask`
 * offer (`utils/paneAsk.ts`), and whichever client the user answers in runs
 * it or drops it. The keyboard answers while the pane holds it
 * (`machines/actors/keyboardActor`): Enter runs, Escape drops, any other key
 * drops it and goes on to the shell. A click on either half answers too.
 *
 * Unlike a send's question this covers nothing: the pane stays readable and
 * typeable under it.
 */

import { memo } from 'react';
import { useAppSend, usePane } from '../machines/appHooks';
import { paneOfferFor } from '../utils/paneAsk';
import type { PaneId } from '../domain/ids';
import './OfferBanner.css';

export const OfferBanner = memo(function OfferBanner({ paneId }: { paneId: PaneId }) {
  const pane = usePane(paneId);
  const send = useAppSend();
  const offer = paneOfferFor(pane);

  if (!offer) return null;

  const answer = (run: boolean) => send({ type: 'ANSWER_ASK', paneId, answer: run ? 'yes' : 'no' });

  return (
    <div
      className="offer-banner"
      role="status"
      aria-label={`Restored command: ${offer.command}`}
      data-pane-offer={paneId}
      // The pane keeps the keyboard, so Enter and Escape still reach it.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="offer-banner-run" tabIndex={-1} onClick={() => answer(true)}>
        ↵ to run:
      </button>
      <span className="offer-banner-command">{offer.command}</span>
      <button
        type="button"
        className="offer-banner-dismiss"
        tabIndex={-1}
        onClick={() => answer(false)}
      >
        · esc to dismiss
      </button>
    </div>
  );
});
