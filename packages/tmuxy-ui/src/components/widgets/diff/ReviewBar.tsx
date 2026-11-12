/**
 * The review's foot: how many comments there are, which pane they go to, and
 * Send review, which types them there as one numbered prompt — a paste,
 * bracketed when the program asked for one, then Enter. Refused while that
 * pane's agent waits for an answer (`sendRefusal`): the prompt would answer it.
 */

import { useMemo, useState } from 'react';
import { useAppSelector, useAppSend, usePane } from '../../../machines/appHooks';
import { selectPanes } from '../../../machines/selectors/layout';
import { TmuxOp } from '../../../domain/commands';
import { waitsForAnswer } from '../../../domain/paneState';
import { namedTarget, reviewPrompt, sendRefusal, type ReviewComment } from '../../../domain/review';
import type { DiffScope } from '../../../domain/diff';
import type { PaneId } from '../../../domain/ids';

export function ReviewBar({
  paneId,
  lines,
  checkout,
  scope,
  comments,
  onSent,
}: {
  paneId: PaneId;
  lines: readonly string[];
  checkout: string;
  scope: DiffScope;
  comments: readonly ReviewComment[];
  onSent: () => void;
}) {
  const send = useAppSend();
  const own = usePane(paneId);
  const panes = useAppSelector(selectPanes);
  // The other panes of the widget's tab: an agent there is who the review is for.
  const candidates = useMemo(
    () => panes.filter((p) => p.windowId === own?.windowId && p.tmuxId !== paneId),
    [panes, own?.windowId, paneId],
  );
  const named = namedTarget(lines);
  const fallback =
    candidates.find((p) => p.tmuxId === named) ??
    candidates.find((p) => p.paneState) ??
    candidates[0];
  const [chosen, setChosen] = useState<string | null>(null);
  const target = candidates.find((p) => p.tmuxId === chosen) ?? fallback;

  if (comments.length === 0) return null;
  const count = `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`;

  const sendReview = () => {
    const refusal = sendRefusal(target);
    if (refusal || !target) {
      send({ type: 'NOTIFY', text: `Review not sent: ${refusal ?? 'no pane to send it to'}` });
      return;
    }
    const prompt = reviewPrompt(checkout, scope, comments);
    send({ type: 'DISPATCH_OP', op: TmuxOp.PasteText({ target: target.tmuxId, text: prompt }) });
    send({ type: 'DISPATCH_OP', op: TmuxOp.SendKeys({ target: target.tmuxId, keys: 'Enter' }) });
    send({ type: 'NOTIFY', kind: 'info', text: `Sent ${count} to ${target.tmuxId}` });
    onSent();
  };

  return (
    <div className="diff-review-bar" data-diff-review="">
      <span className="diff-review-count">{count}</span>
      <label className="diff-review-target">
        to
        <select
          aria-label="Send the review to"
          value={target?.tmuxId ?? ''}
          onChange={(e) => setChosen(e.target.value)}
        >
          {candidates.map((p) => (
            <option key={p.tmuxId} value={p.tmuxId}>
              {`${p.tmuxId} ${p.command}${waitsForAnswer(p) ? ' (waiting for you)' : ''}`}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="diff-review-send" disabled={!target} onClick={sendReview}>
        Send review
      </button>
    </div>
  );
}
