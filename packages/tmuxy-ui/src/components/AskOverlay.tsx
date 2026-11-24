/**
 * A question drawn over a pane, on a blurred scrim, from the pane's
 * `@tmuxy-ask` option (`domain/paneAsk.ts`). Two kinds:
 *
 * - `tmuxy pane send -t %3 'npm test' Enter`, run from another pane, does not
 *   send the keys: it asks "claude wants to send npm test. Allow?" and blocks
 *   until the answer chosen here is written back.
 * - `tmuxy pane ask "Deploy?" --choice yes --choice no` asks the person a
 *   question of a script's or an agent's own, with its choices as buttons or
 *   a line of text, and prints the answer.
 *
 * Besides a click, the keyboard answers while this pane holds it (↑/↓ or a
 * digit move the highlight, Enter takes it, Escape declines;
 * `machines/actors/keyboardActor`), and Cmd+Enter (Ctrl+Enter off macOS)
 * anywhere in the tab allows every send waiting in it.
 *
 * Nothing here holds DOM focus but a text question's field: the pane keeps
 * it, so keys typed while reading the question cannot leak into the shell
 * behind the overlay. The question's words are a script's free text, shown
 * as text, never as markup.
 */

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppSend, useAppSelector, usePane } from '../machines/appHooks';
import {
  askAnswerCount,
  askSelection,
  paneOverlayAskFor,
  SEND_ANSWERS,
  sentText,
  sentTextIsLong,
  type QuestionAsk,
  type QuestionReply,
  type SendAsk,
} from '../domain/paneAsk';
import { QUESTION_LIMITS } from '../domain/tmuxyConstants.gen';
import { selectPaneHoldsKeyboard } from '../machines/selectors/keyboard';
import { focusKeyboardInput, touchIsPrimary } from '../infra/dom/mobileKeyboard';
import './AskOverlay.css';
import type { PaneId } from '../domain/ids';

interface AskOverlayProps {
  paneId: PaneId;
}

export const AskOverlay = memo(function AskOverlay({ paneId }: AskOverlayProps) {
  const pane = usePane(paneId);
  const ask = paneOverlayAskFor(pane);
  const count = ask ? askAnswerCount(ask) : 0;
  const selected = useAppSelector((context) => askSelection(context.askSelections, paneId, count));

  if (!pane || !ask) return null;

  return ask.kind === 'send' ? (
    <SendQuestion paneId={paneId} ask={ask} selected={selected} />
  ) : (
    <PaneQuestion paneId={paneId} ask={ask} selected={selected} />
  );
});

interface ShellProps {
  paneId: PaneId;
  label: string;
  /** The highlighted answer, as `data-ask-selected` says it. */
  selected: string;
  children: ReactNode;
}

function AskShell({ paneId, label, selected, children }: ShellProps) {
  return (
    <div
      className="ask-overlay"
      role="alertdialog"
      aria-label={label}
      data-pane-ask={paneId}
      data-ask-selected={selected}
      // The pane keeps the keyboard: a click on the text must not take focus
      // from it, or the arrows and Enter would stop reaching the answers.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="ask-overlay-scrim" />
      <div className="ask-overlay-text" data-own-touch>
        {children}
      </div>
    </div>
  );
}

interface ChoicesProps {
  paneId: PaneId;
  labels: readonly string[];
  /** What each button's `data-ask-choice` says: the send's answer, or a choice's place. */
  ids: readonly string[];
  selected: number;
  /** Real Tab stops (a question's), or none (a send's, whose pane keeps the keys). */
  focusable: boolean;
  onPick: (index: number) => void;
}

function AskChoices({ paneId, labels, ids, selected, focusable, onPick }: ChoicesProps) {
  const send = useAppSend();
  return (
    <div className="ask-overlay-choices">
      {labels.map((label, index) => (
        <button
          key={ids[index]}
          type="button"
          className={`ask-overlay-choice ${selected === index ? 'ask-overlay-choice-selected' : ''}`}
          data-ask-choice={ids[index]}
          aria-pressed={selected === index}
          tabIndex={focusable ? 0 : -1}
          onMouseEnter={() => send({ type: 'MOVE_ASK_SELECTION', paneId, to: index })}
          onClick={() => onPick(index)}
        >
          <span className="ask-overlay-choice-number">{index + 1}.</span>
          {label}
        </button>
      ))}
    </div>
  );
}

const SEND_LABELS = ['Yes', 'No'];

function SendQuestion({
  paneId,
  ask,
  selected,
}: {
  paneId: PaneId;
  ask: SendAsk;
  selected: number;
}) {
  const send = useAppSend();
  const text = sentText(ask.keys);
  const caller = <code className="ask-overlay-caller">{ask.caller}</code>;
  return (
    <AskShell
      paneId={paneId}
      label={`${ask.caller} wants to send ${text}. Allow?`}
      selected={SEND_ANSWERS[selected]}
    >
      {sentTextIsLong(text) ? (
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
      <AskChoices
        paneId={paneId}
        labels={SEND_LABELS}
        ids={SEND_ANSWERS}
        selected={selected}
        focusable={false}
        onPick={(index) => send({ type: 'ANSWER_ASK', paneId, answer: SEND_ANSWERS[index] })}
      />
    </AskShell>
  );
}

interface QuestionProps {
  paneId: PaneId;
  ask: QuestionAsk;
  selected: number;
}

function PaneQuestion({ paneId, ask, selected }: QuestionProps) {
  const send = useAppSend();
  const reply = (answer: QuestionReply) => send({ type: 'ANSWER_QUESTION', paneId, reply: answer });
  return (
    <AskShell
      paneId={paneId}
      label={`${ask.caller} asks: ${ask.question}`}
      selected={ask.text ? '' : String(selected)}
    >
      <p className="ask-overlay-question">
        <code className="ask-overlay-caller">{ask.caller}</code> asks:
      </p>
      <p className="ask-overlay-prompt">{ask.question}</p>
      {ask.text ? (
        <AskTextField paneId={paneId} label={ask.question} onReply={reply} />
      ) : (
        <AskChoices
          paneId={paneId}
          labels={ask.choices}
          ids={ask.choices.map((_, index) => String(index))}
          selected={selected}
          focusable
          onPick={(index) => reply({ choice: index })}
        />
      )}
      {/* Escape's twin, for a finger: dismissing is an answer of its own (exit 1). */}
      <button
        type="button"
        className="ask-overlay-dismiss"
        data-ask-dismiss
        onClick={() => reply('dismiss')}
      >
        esc · dismiss
      </button>
    </AskShell>
  );
}

interface TextFieldProps {
  paneId: PaneId;
  label: string;
  onReply: (reply: QuestionReply) => void;
}

/**
 * One line and Submit. The field is a real form control, so the keyboard
 * actor leaves what is typed in it alone; it takes the focus whenever its
 * pane holds the keyboard (not on a phone, where only a tap brings the
 * keyboard up), and gives it back to the pane once answered.
 */
function AskTextField({ paneId, label, onReply }: TextFieldProps) {
  const send = useAppSend();
  const [value, setValue] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const holds = useAppSelector((context) => selectPaneHoldsKeyboard(context, paneId));
  useEffect(() => {
    if (holds && !touchIsPrimary()) field.current?.focus();
  }, [holds]);
  const answer = (reply: QuestionReply) => {
    onReply(reply);
    if (document.activeElement === field.current && !touchIsPrimary()) focusKeyboardInput(paneId);
  };
  return (
    <form
      className="ask-overlay-form"
      onSubmit={(e) => {
        e.preventDefault();
        answer({ text: value });
      }}
    >
      <input
        ref={field}
        className="ask-overlay-input"
        data-ask-text
        aria-label={label}
        value={value}
        maxLength={QUESTION_LIMITS.answerChars}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          answer('dismiss');
        }}
        // A press here is the field's: it takes the focus, and the pane
        // under it starts no selection of its own.
        onMouseDown={(e) => {
          e.stopPropagation();
          send({ type: 'SELECT_PANE', paneId });
        }}
      />
      <button type="submit" className="ask-overlay-choice ask-overlay-submit" data-ask-submit>
        Submit
      </button>
    </form>
  );
}
