/**
 * `tmuxy pane send -t %3 'npm test' Enter`, run from another pane, does not
 * send the keys: it writes the question to this pane's `@tmuxy-ask` option and
 * blocks until the answer chosen here is written back (`domain/paneAsk.ts`).
 *
 * Besides a click, the keyboard answers while this pane holds it (↑/↓ or 1/2,
 * Enter, Escape declines; `machines/actors/keyboardActor`), and Cmd+Enter
 * (Ctrl+Enter off macOS) anywhere in the tab allows every send waiting in it.
 *
 * Nothing here holds DOM focus: the pane keeps it, so keys typed while reading
 * the question cannot leak into the shell behind the overlay.
 */

import { memo } from 'react';
import { useAppSend, useAppSelector, usePane } from '../machines/appHooks';
import { paneSendFor, sentText, sentTextIsLong, type AskAnswer } from '../domain/paneAsk';
import './AskOverlay.css';
import type { PaneId } from '../domain/ids';

interface AskOverlayProps {
  paneId: PaneId;
}

const CHOICES: ReadonlyArray<{ answer: AskAnswer; label: string }> = [
  { answer: 'yes', label: 'Yes' },
  { answer: 'no', label: 'No' },
];

export const AskOverlay = memo(function AskOverlay({ paneId }: AskOverlayProps) {
  const pane = usePane(paneId);
  const send = useAppSend();
  const selected = useAppSelector((context) => context.askSelections[paneId] ?? 'yes');
  const ask = paneSendFor(pane);

  if (!pane || !ask) return null;

  const text = sentText(ask.keys);
  const long = sentTextIsLong(text);
  const caller = <code className="ask-overlay-caller">{ask.caller}</code>;

  return (
    <div
      className="ask-overlay"
      role="alertdialog"
      aria-label={`${ask.caller} wants to send ${text}. Allow?`}
      data-pane-ask={paneId}
      data-ask-selected={selected}
      // The pane keeps the keyboard: a click on the text must not take focus
      // from it, or the arrows and Enter would stop reaching the answers.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="ask-overlay-scrim" />
      <div className="ask-overlay-text">
        {long ? (
          <>
            <p className="ask-overlay-question">{caller} wants to send:</p>
            <pre className="ask-overlay-command-block">{text}</pre>
            <p className="ask-overlay-question">Allow?</p>
          </>
        ) : (
          <p className="ask-overlay-question">
            {caller} wants to send <code className="ask-overlay-command">{text}</code>.
            <br />
            Allow?
          </p>
        )}
        <div className="ask-overlay-choices">
          {CHOICES.map(({ answer, label }, index) => (
            <button
              key={answer}
              type="button"
              className={`ask-overlay-choice ${
                selected === answer ? 'ask-overlay-choice-selected' : ''
              }`}
              data-ask-choice={answer}
              aria-pressed={selected === answer}
              tabIndex={-1}
              onMouseEnter={() => send({ type: 'MOVE_ASK_SELECTION', paneId, to: answer })}
              onClick={() => send({ type: 'ANSWER_ASK', paneId, answer })}
            >
              <span className="ask-overlay-choice-number">{index + 1}.</span>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});
