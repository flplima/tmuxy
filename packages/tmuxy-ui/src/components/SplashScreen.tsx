/**
 * A new desktop window's first page: a new session on this machine, the
 * sessions already running there, one click to join one, and a form to
 * attach to another machine over ssh instead (SplashSshForm.tsx;
 * infra/splashWindow.ts). Shown in place of the app until the window has
 * attached; the first window, and every browser tab, never sees it.
 */

import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  attachError,
  attachWindow,
  listLocalSessions,
  listSshHosts,
  pickSshFile,
  type AttachChoice,
  type AttachOutcome,
  type LocalSession,
  type SshForm,
} from '../infra/splashWindow';
import { SplashSshForm } from './SplashSshForm';
import './SplashScreen.css';

interface SplashScreenProps {
  /** The window has attached: show the app. */
  onAttached: () => void;
  /** The sessions to list (the desktop's, unless a story supplies them). */
  list?: () => Promise<LocalSession[]>;
  /** Attach the window (the desktop's, unless a story supplies it). */
  attach?: (choice: AttachChoice) => Promise<AttachOutcome>;
  /** The hosts of the user's ssh config, offered by the host field. */
  sshHosts?: () => Promise<string[]>;
  /** A native chooser for a key or certificate file. */
  pickFile?: () => Promise<string | null>;
}

const tabs = (n: number) => `${n} tab${n === 1 ? '' : 's'}`;

/** What a new session is called when it is given no name: the desktop's rule. */
function nextSessionNumber(sessions: LocalSession[]): string {
  const taken = new Set(sessions.map((s) => s.name));
  let n = 1;
  while (taken.has(String(n))) n++;
  return String(n);
}

export function SplashScreen({
  onAttached,
  list = listLocalSessions,
  attach = attachWindow,
  sshHosts = listSshHosts,
  pickFile = pickSshFile,
}: SplashScreenProps) {
  const nameId = useId();
  const [sessions, setSessions] = useState<LocalSession[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
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

  /** Attach as chosen: the host's fingerprint when it is to be confirmed. */
  const go = async (choice: AttachChoice): Promise<{ fingerprint: string | null } | null> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await attach(choice);
      if ('unknownHost' in outcome) {
        setBusy(false);
        return outcome.unknownHost;
      }
      onAttached();
      return null;
    } catch (e: unknown) {
      setError(attachError(e));
      setBusy(false);
      return null;
    }
  };

  const createSession = (e: FormEvent) => {
    e.preventDefault();
    void go({ newSession: name.trim() });
  };

  return (
    // The page scrolls when the window is short, and while it connects every
    // control in it is disabled: it takes the focus itself so the keys can
    // still scroll it.
    <main className="splash" data-testid="splash" tabIndex={0} aria-label="Attach this window">
      <header className="splash-head" data-tauri-drag-region>
        <h1 className="splash-title">tmuxy</h1>
        <p className="splash-lede">Where should this window attach?</p>
      </header>

      <section className="splash-section" aria-labelledby="splash-local">
        <h2 id="splash-local" className="splash-heading">
          This machine
        </h2>
        <ul className="splash-sessions">
          <li>
            {naming ? (
              <form className="splash-new" onSubmit={createSession} aria-label="New session">
                <label className="splash-label" htmlFor={nameId}>
                  Name of the new session
                </label>
                <div className="splash-row">
                  <input
                    id={nameId}
                    className="splash-input"
                    placeholder={sessions ? nextSessionNumber(sessions) : ''}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                    autoFocus
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <button type="submit" className="splash-connect" disabled={busy}>
                    Create
                  </button>
                  <button
                    type="button"
                    className="splash-secondary"
                    disabled={busy}
                    onClick={() => setNaming(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="splash-session splash-session-new"
                disabled={busy}
                onClick={() => setNaming(true)}
              >
                <span className="splash-session-name">
                  <span className="splash-plus" aria-hidden="true">
                    +
                  </span>
                  New session
                </span>
                <span className="splash-session-meta">on this machine</span>
              </button>
            )}
          </li>
          {sessions === null ? (
            <li className="splash-note">Looking for sessions…</li>
          ) : (
            sessions.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  className="splash-session"
                  disabled={busy}
                  onClick={() => void go({ session: s.name })}
                >
                  <span className="splash-session-name">{s.name}</span>
                  <span className="splash-session-meta">
                    {tabs(s.windows)}
                    {s.attached && <span className="splash-badge">attached</span>}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="splash-section" aria-labelledby="splash-remote">
        <h2 id="splash-remote" className="splash-heading">
          Another machine over SSH
        </h2>
        <SplashSshForm
          connect={(form: SshForm) => go({ ssh: form })}
          hosts={sshHosts}
          pickFile={pickFile}
          disabled={busy}
        />
      </section>

      {error && (
        <p className="splash-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
