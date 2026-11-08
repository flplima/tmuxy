/**
 * A new desktop window's first page: the sessions on this machine, one click
 * to join one, and a field for an ssh host to attach to instead
 * (infra/splashWindow.ts). Shown in place of the app until the window has
 * attached; the first window, and every browser tab, never sees it.
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  attachError,
  attachWindow,
  listLocalSessions,
  type AttachChoice,
  type LocalSession,
} from '../infra/splashWindow';
import './SplashScreen.css';

interface SplashScreenProps {
  /** The window has attached: show the app. */
  onAttached: () => void;
  /** The sessions to list (the desktop's, unless a story supplies them). */
  list?: () => Promise<LocalSession[]>;
  /** Attach the window (the desktop's, unless a story supplies it). */
  attach?: (choice: AttachChoice) => Promise<void>;
}

const tabs = (n: number) => `${n} tab${n === 1 ? '' : 's'}`;

export function SplashScreen({
  onAttached,
  list = listLocalSessions,
  attach = attachWindow,
}: SplashScreenProps) {
  const [sessions, setSessions] = useState<LocalSession[] | null>(null);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    list()
      .then((found) => live && setSessions(found))
      .catch((e: unknown) => {
        if (!live) return;
        setSessions([]);
        setError(attachError(e));
      });
    return () => {
      live = false;
    };
  }, [list]);

  const go = (choice: AttachChoice) => {
    setBusy(true);
    setError(null);
    attach(choice)
      .then(onAttached)
      .catch((e: unknown) => {
        setError(attachError(e));
        setBusy(false);
      });
  };

  const connect = (e: FormEvent) => {
    e.preventDefault();
    const dest = host.trim();
    if (dest) go({ ssh: dest });
  };

  return (
    <div className="splash" data-testid="splash">
      <header className="splash-head" data-tauri-drag-region>
        <h1 className="splash-title">tmuxy</h1>
        <p className="splash-lede">Where should this window attach?</p>
      </header>

      <section className="splash-section" aria-labelledby="splash-local">
        <h2 id="splash-local" className="splash-heading">
          Sessions on this machine
        </h2>
        {sessions === null ? (
          <p className="splash-note">Looking for sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="splash-note">No tmuxy session is running on this machine.</p>
        ) : (
          <ul className="splash-sessions">
            {sessions.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  className="splash-session"
                  disabled={busy}
                  onClick={() => go({ session: s.name })}
                >
                  <span className="splash-session-name">{s.name}</span>
                  <span className="splash-session-meta">
                    {tabs(s.windows)}
                    {s.attached && <span className="splash-badge">attached</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="splash-section" aria-labelledby="splash-remote">
        <h2 id="splash-remote" className="splash-heading">
          A remote machine over SSH
        </h2>
        <form className="splash-ssh" onSubmit={connect}>
          <input
            className="splash-input"
            aria-label="SSH host"
            placeholder="user@host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button type="submit" className="splash-connect" disabled={busy || !host.trim()}>
            Connect
          </button>
        </form>
      </section>

      {error && (
        <p className="splash-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
