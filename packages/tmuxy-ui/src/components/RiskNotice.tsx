/**
 * RiskNotice — the first-run dialog. Says plainly that tmuxy is alpha software
 * written largely by AI agents, and that it hands a shell to whoever can reach
 * it. Presentational: the machine owns whether it is open (`riskNoticeOpen`)
 * and keeps the keyboard away from the panes while it is.
 */

import { useState } from 'react';
import { useAppSelector, useAppSend } from '../machines/AppContext';
import { isTauri } from '../tmux/adapters';
import { openExternalUrl } from '../utils/openUrl';
import './RiskNotice.css';

const SECURITY_DOC = 'https://github.com/flplima/tmuxy/blob/main/docs/SECURITY.md';

export function RiskNotice() {
  const open = useAppSelector((ctx) => ctx.riskNoticeOpen);
  const send = useAppSend();
  const [remember, setRemember] = useState(false);
  if (!open) return null;

  return (
    <div className="risk-notice" data-testid="risk-notice">
      <div
        className="risk-notice-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="risk-notice-title"
        // Focus lands on the dialog, not on its button: a button holding focus
        // is pressed by Space and Enter, and someone already typing a command
        // would dismiss the notice without ever seeing it.
        tabIndex={-1}
        ref={(card) => card?.focus()}
      >
        <h2 id="risk-notice-title" className="risk-notice-title">
          Before you use tmuxy
        </h2>
        <p>
          tmuxy is <strong>alpha software</strong>, and most of its code was written by AI agents
          with a human steering. It has not been audited. Expect bugs.
        </p>
        {isTauri() ? (
          <p>
            It drives your real tmux server: everything it does — closing a pane, killing a session
            — happens for real.
          </p>
        ) : (
          <>
            <p>
              It is also a <strong>remote control for your shell</strong>. Anyone who can reach this
              server can run commands as you, read your files and see everything on screen.
            </p>
            <ul>
              <li>Keep it on localhost, or reach it through an SSH tunnel or a VPN.</li>
              <li>Set a password before listening on any other address.</li>
              <li>Never expose it to the internet.</li>
            </ul>
          </>
        )}
        <p>
          <a
            href={SECURITY_DOC}
            onClick={(e) => {
              e.preventDefault();
              openExternalUrl(SECURITY_DOC);
            }}
          >
            Security notes
          </a>
        </p>
        <div className="risk-notice-actions">
          <label className="risk-notice-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Don&apos;t show this again
          </label>
          <button
            type="button"
            className="risk-notice-accept"
            onClick={() => send({ type: 'DISMISS_RISK_NOTICE', remember })}
          >
            I understand
          </button>
        </div>
      </div>
    </div>
  );
}
