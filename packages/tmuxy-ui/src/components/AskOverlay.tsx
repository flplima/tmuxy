/**
 * AskOverlay — the question a pane is waiting on, drawn over its own content.
 *
 * `tmuxy ask %3 npm test Enter`, run from another pane (usually by an agent),
 * does not send the keys. It writes the question to this pane's `@tmuxy-ask`
 * option and blocks; this is what the user sees in answer, and what they
 * choose here is what the waiting command reads back. See `utils/paneAsk.ts`.
 *
 * Three ways to answer, all landing on the same machine events:
 *  - click Yes / No;
 *  - the keyboard, while this pane holds it — the arrows or Tab move the
 *    highlight, Enter takes it, Escape declines (`machines/actors/keyboardActor`);
 *  - Cmd+Enter (Ctrl+Enter off macOS) from anywhere in the tab, which says yes
 *    to every question in it — the point of the feature: you agree from the
 *    agent's pane without ever leaving it.
 *
 * Nothing here holds DOM focus. The pane keeps it, so that the keys the user
 * types while reading a question cannot leak into the shell behind the
 * overlay, and so the arrows reach the highlight rather than a focused button.
 */

import { memo } from 'react';
import { useAppSend, useAppSelector, usePane, useReadOnly } from '../machines/AppContext';
import { paneAskFor } from '../utils/paneAsk';
import type { AskAnswer } from '../utils/paneAsk';
import './AskOverlay.css';

interface AskOverlayProps {
  paneId: string;
  /**
   * Whether this pane holds the keyboard. Only then is the keyboard hint true
   * — in any other pane the question is answered by clicking it, or by the
   * tab-wide shortcut.
   */
  holdsKeyboard: boolean;
}

/**
 * Below this the card's own padding would crowd out the question. A pane that
 * small still says it is waiting; it just drops the detail and the hint.
 */
const COMPACT_COLS = 40;
const COMPACT_ROWS = 8;

const CHOICES: ReadonlyArray<{ answer: AskAnswer; label: string }> = [
  { answer: 'yes', label: 'Yes' },
  { answer: 'no', label: 'No' },
];

export const AskOverlay = memo(function AskOverlay({ paneId, holdsKeyboard }: AskOverlayProps) {
  const pane = usePane(paneId);
  const send = useAppSend();
  const readOnly = useReadOnly();
  const selected = useAppSelector((context) => context.askSelections[paneId] ?? 'yes');
  const ask = paneAskFor(pane);

  if (!pane || !ask) return null;

  const compact = pane.width < COMPACT_COLS || pane.height < COMPACT_ROWS;

  return (
    <div
      className={`ask-overlay ${compact ? 'ask-overlay-compact' : ''}`}
      role="alertdialog"
      aria-label={ask.question}
      data-pane-ask={paneId}
      data-ask-selected={selected}
    >
      <div className="ask-overlay-scrim" />
      <div className="ask-overlay-card">
        <p className="ask-overlay-question">{ask.question}</p>
        {ask.description && <p className="ask-overlay-description">{ask.description}</p>}
        <div className="ask-overlay-choices">
          {CHOICES.map(({ answer, label }) => (
            <button
              key={answer}
              type="button"
              className={`ask-overlay-choice ${
                selected === answer ? 'ask-overlay-choice-selected' : ''
              }`}
              data-ask-choice={answer}
              aria-pressed={selected === answer}
              disabled={readOnly}
              // The pane keeps the keyboard: a focused button would swallow
              // the arrows that move this highlight, and Enter would then
              // click whatever the browser focused rather than what the user
              // can see is selected.
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => send({ type: 'MOVE_ASK_SELECTION', paneId, to: answer })}
              onClick={() => send({ type: 'ANSWER_ASK', paneId, answer })}
            >
              {label}
            </button>
          ))}
        </div>
        {holdsKeyboard && (
          <p className="ask-overlay-hint">←/→ then Enter · ⌘/Ctrl+Enter answers the whole tab</p>
        )}
      </div>
    </div>
  );
});
