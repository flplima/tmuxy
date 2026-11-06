/**
 * A command a session restore offers to run again. The restore does not type
 * it (that would race the shell's start-up and show twice) nor run it (a
 * program that was running is not proof it should run again): it hangs an
 * `@tmuxy-ask` offer on the pane (`domain/paneAsk.ts`). The keyboard answers
 * while the pane holds it (`machines/actors/keyboardActor`): Enter runs,
 * Escape drops, any other key drops it and goes on to the shell.
 */

import { memo } from 'react';
import { useAppSend, usePane } from '../machines/appHooks';
import { paneOfferFor } from '../domain/paneAsk';
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
