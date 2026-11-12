/**
 * The review's foot: how many comments there are, which agent they go to,
 * and Send review, which types them there as one numbered prompt — a paste,
 * bracketed when the agent asked for one, then Enter, in one command list
 * tmux runs only if the agent waits for nothing (`reviewInto`). Only a pane
 * running an agent is offered: a shell would run the review's lines. A
 * review once sent can be restored, for when tmux refused it.
 */

import { useMemo, useState } from 'react';
import { useAppSelector, useAppSend, usePane } from '../../../machines/appHooks';
import { selectPanes } from '../../../machines/selectors/layout';
import { TmuxOp } from '../../../domain/commands';
import { waitsForAnswer } from '../../../domain/paneState';
import {
  isAgentPane,
  namedTarget,
  reviewPrompt,
  sendRefusal,
  type ReviewComment,
} from '../../../domain/review';
import type { DiffScope } from '../../../domain/diff';
import type { PaneId } from '../../../domain/ids';

/** The agents of the widget's tab, and the one a review goes to unless another is picked. */
function useAgents(paneId: PaneId, lines: readonly string[]) {
  const own = usePane(paneId);
  const panes = useAppSelector(selectPanes);
  const agents = useMemo(
    () =>
      panes.filter((p) => p.windowId === own?.windowId && p.tmuxId !== paneId && isAgentPane(p)),
    [panes, own?.windowId, paneId],
  );
  const named = namedTarget(lines);
  return { agents, fallback: agents.find((p) => p.tmuxId === named) ?? agents[0] };
}

export function ReviewBar({
  paneId,
  lines,
  checkout,
  scope,
  comments,
  onSent,
  onRestore,
}: {
  paneId: PaneId;
  lines: readonly string[];
  checkout: string;
  scope: DiffScope;
  comments: readonly ReviewComment[];
  onSent: () => void;
  /** Brings the last review sent back, when there is one and nothing is written. */
  onRestore: (() => void) | null;
}) {
  const send = useAppSend();
  const { agents, fallback } = useAgents(paneId, lines);
  const [chosen, setChosen] = useState<string | null>(null);
  const target = agents.find((p) => p.tmuxId === chosen) ?? fallback;

  if (comments.length === 0) {
    if (!onRestore) return null;
    return (
      <div className="diff-review-bar" data-diff-review="">
        <button type="button" onClick={onRestore}>
          Restore the last review
        </button>
      </div>
    );
  }
  const count = `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`;

  const sendReview = () => {
    const refusal = sendRefusal(target);
    if (refusal || !target) {
      send({ type: 'NOTIFY', text: `Review not sent: ${refusal ?? 'no agent to send it to'}` });
      return;
    }
    const text = reviewPrompt(checkout, scope, comments);
    send({ type: 'DISPATCH_OP', op: TmuxOp.SendReview({ target: target.tmuxId, text }) });
    send({ type: 'NOTIFY', kind: 'info', text: `Sent ${count} to ${target.tmuxId}` });
    onSent();
  };

  return (
    <div className="diff-review-bar" data-diff-review="">
      <span className="diff-review-count">{count}</span>
      {agents.length > 0 ? (
        <label className="diff-review-target">
          to
          <select
            aria-label="Send the review to"
            value={target?.tmuxId ?? ''}
            onChange={(e) => setChosen(e.target.value)}
          >
            {agents.map((p) => (
              <option key={p.tmuxId} value={p.tmuxId}>
                {`${p.tmuxId} ${p.command}${waitsForAnswer(p) ? ' (waiting for you)' : ''}`}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="diff-review-target">no agent in this tab</span>
      )}
      <button type="button" className="diff-review-send" disabled={!target} onClick={sendReview}>
        Send review
      </button>
    </div>
  );
}
