/**
 * The splash page's ssh form (components/SplashScreen.tsx), laid out as the
 * well-known connection dialogs lay theirs out (Termius, Tabby, WindTerm,
 * MobaXterm): the host and its port on one row, the user, then a sign-in
 * group whose every field is optional — a password (or the key's passphrase),
 * a key file and a certificate, each with a native chooser. Left empty, ssh
 * does what it does in a terminal. A host whose key is not known yet asks
 * for its fingerprint to be confirmed before anything is sent to it.
 */

import { useEffect, useId, useState, type FormEvent } from 'react';
import type { SshForm } from '../infra/splashWindow';

interface SplashSshFormProps {
  /** Connect: resolves with the host's fingerprint when its key is to be confirmed, else null. */
  connect: (form: SshForm) => Promise<{ fingerprint: string | null } | null>;
  /** The names in `~/.ssh/config`, offered by the host field. */
  hosts: () => Promise<string[]>;
  /** A native file chooser, for the key and the certificate. */
  pickFile: () => Promise<string | null>;
  /** Another choice on the page is in flight. */
  disabled: boolean;
}

/** A path field with its chooser button beside it. */
function FileField({
  label,
  value,
  onChange,
  pickFile,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  pickFile: () => Promise<string | null>;
  disabled: boolean;
  placeholder: string;
}) {
  const id = useId();
  return (
    <div className="splash-field">
      <label className="splash-label" htmlFor={id}>
        {label}
      </label>
      <div className="splash-row">
        <input
          id={id}
          className="splash-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button
          type="button"
          className="splash-secondary"
          aria-label={`Choose the ${label.toLowerCase()}`}
          disabled={disabled}
          onClick={() => {
            void pickFile().then((path) => path && onChange(path));
          }}
        >
          Browse…
        </button>
      </div>
    </div>
  );
}

export function SplashSshForm({ connect, hosts, pickFile, disabled }: SplashSshFormProps) {
  const ids = { host: useId(), port: useId(), user: useId(), pass: useId(), list: useId() };
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [key, setKey] = useState('');
  const [cert, setCert] = useState('');
  const [known, setKnown] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Set while the page asks whether to trust the host's key.
  const [unknown, setUnknown] = useState<{ fingerprint: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    hosts()
      .then((found) => live && setKnown(found))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [hosts]);

  const portNumber = port.trim() === '' ? undefined : Number(port);
  const portBad = portNumber !== undefined && !(portNumber >= 1 && portNumber <= 65535);
  const off = disabled || busy;

  const send = (trustNewHost: boolean) => {
    const form: SshForm = {
      host: host.trim(),
      ...(user.trim() && { user: user.trim() }),
      ...(portNumber !== undefined && { port: portNumber }),
      ...(key.trim() && { identityFile: key.trim() }),
      ...(cert.trim() && { certificateFile: cert.trim() }),
      ...(password && { password }),
      ...(trustNewHost && { trustNewHost }),
    };
    setBusy(true);
    connect(form)
      .then((asked) => setUnknown(asked))
      .finally(() => setBusy(false));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (host.trim() && !portBad && !off) send(false);
  };

  // Where the trust question names the host: as the user would type it.
  const where = `${user.trim() ? `${user.trim()}@` : ''}${host.trim()}${portNumber ? `:${portNumber}` : ''}`;

  return (
    <form className="splash-ssh" onSubmit={submit} aria-label="Connect over SSH">
      <div className="splash-row">
        <div className="splash-field splash-grow">
          <label className="splash-label" htmlFor={ids.host}>
            Host
          </label>
          <input
            id={ids.host}
            className="splash-input"
            placeholder="hostname, address or user@host"
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              setUnknown(null);
            }}
            list={known.length ? ids.list : undefined}
            disabled={off}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          {known.length > 0 && (
            <datalist id={ids.list}>
              {known.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          )}
        </div>
        <div className="splash-field splash-port">
          <label className="splash-label" htmlFor={ids.port}>
            Port
          </label>
          <input
            id={ids.port}
            className="splash-input"
            inputMode="numeric"
            placeholder="22"
            value={port}
            aria-invalid={portBad}
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
            disabled={off}
          />
        </div>
      </div>

      <div className="splash-field">
        <label className="splash-label" htmlFor={ids.user}>
          User
        </label>
        <input
          id={ids.user}
          className="splash-input"
          placeholder="as in your ssh config, else your login name"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          disabled={off}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>

      <fieldset className="splash-group">
        <legend className="splash-legend">Sign in — optional</legend>
        <div className="splash-field">
          <label className="splash-label" htmlFor={ids.pass}>
            Password or key passphrase
          </label>
          <div className="splash-row">
            <input
              id={ids.pass}
              className="splash-input"
              type={showPassword ? 'text' : 'password'}
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={off}
            />
            <button
              type="button"
              className="splash-secondary"
              aria-pressed={showPassword}
              disabled={off}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <FileField
          label="Key file"
          value={key}
          onChange={setKey}
          pickFile={pickFile}
          disabled={off}
          placeholder="~/.ssh/id_ed25519"
        />
        <FileField
          label="Certificate"
          value={cert}
          onChange={setCert}
          pickFile={pickFile}
          disabled={off}
          placeholder="~/.ssh/id_ed25519-cert.pub"
        />
        <p className="splash-hint">
          Left empty, ssh signs in as it does in a terminal: your agent, your keys in ~/.ssh and
          your ssh config. The password is used once, to open the connection, and is not kept.
        </p>
      </fieldset>

      {unknown ? (
        <div className="splash-trust" role="alertdialog" aria-label="Trust this host?">
          <p className="splash-trust-title">First connection to {where}</p>
          <p className="splash-note">
            Its host key is not known to this machine. Check that the fingerprint is the server’s
            before you trust it:
          </p>
          <code className="splash-fingerprint">{unknown.fingerprint ?? 'could not be read'}</code>
          <div className="splash-row">
            <button
              type="button"
              className="splash-connect"
              disabled={off}
              onClick={() => send(true)}
            >
              Trust and connect
            </button>
            <button
              type="button"
              className="splash-secondary"
              disabled={off}
              onClick={() => setUnknown(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="splash-row splash-actions">
          <button
            type="submit"
            className="splash-connect"
            disabled={off || !host.trim() || portBad}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
          {busy && <span className="splash-note">Signing in to {where}</span>}
        </div>
      )}
    </form>
  );
}
