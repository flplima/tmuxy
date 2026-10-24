'use client';

import { useEffect, useState } from 'react';
import { trackEvent } from '@/lib/analytics';

export type Os = 'mac' | 'linux';

export const COMMANDS: Record<Os, { label: string; command: string; assets: string }> = {
  mac: { label: 'macOS', command: 'brew install --cask flplima/tap/tmuxy', assets: 'the DMG' },
  linux: {
    label: 'Linux',
    command: 'brew install flplima/tap/tmuxy',
    assets: 'the .deb or the AppImage',
  },
};

export const RELEASES_URL = 'https://github.com/flplima/tmuxy/releases';

/** The visitor's OS, as far as the browser says: a Mac gets the cask, and so
 *  does an iPhone or iPad, whose owner most likely installs on a Mac; anything
 *  else the formula (Homebrew casks are macOS-only). */
function detectOs(): Os {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  return /mac|iphone|ipad/i.test(platform) ? 'mac' : 'linux';
}

/** A copy icon that puts an OS's install command on the clipboard, and shows
 *  a check for a moment once it is there. */
export function CopyButton({ os }: { os: Os }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const { label, command } = COMMANDS[os];

  const copy = () => {
    void navigator.clipboard.writeText(command).then(() => setCopied(true));
    trackEvent({ name: 'install_copy', params: { os } });
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0"
      aria-label={copied ? 'Copied' : `Copy the ${label} install command`}
      title={copied ? 'Copied' : 'Copy'}
      style={{
        color: copied ? 'var(--accent-green)' : 'var(--text-muted)',
        cursor: 'pointer',
      }}
    >
      {copied ? '' : ''}
    </button>
  );
}

/**
 * The install command for the visitor's OS, with the other one a click away,
 * and the Releases page for whoever wants a package instead. Picked after
 * mount, since the server render cannot know the OS; until then the block
 * keeps its height so nothing below it moves.
 */
export function InstallCommand() {
  const [os, setOs] = useState<Os | null>(null);

  useEffect(() => setOs(detectOs()), []);

  const shown = COMMANDS[os ?? 'mac'];

  return (
    <section
      id="install"
      className="w-full max-w-3xl mt-8 flex flex-col items-center gap-3"
      style={{ visibility: os ? 'visible' : 'hidden' }}
      aria-label="Install tmuxy"
    >
      <div className="flex gap-4 text-sm" role="tablist" aria-label="Operating system">
        {(Object.keys(COMMANDS) as Os[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={os === key}
            onClick={() => setOs(key)}
            style={{
              color: os === key ? 'var(--accent-green)' : 'var(--text-muted)',
              fontWeight: os === key ? 700 : 400,
              cursor: 'pointer',
            }}
          >
            {COMMANDS[key].label}
          </button>
        ))}
      </div>
      <div
        className="w-full flex items-center gap-3 rounded-lg px-4 py-3"
        style={{
          background: 'var(--bg-black, #000)',
          border: '1px solid var(--border-medium, #333)',
          maxWidth: '36rem',
        }}
      >
        <code className="flex-1 min-w-0 break-words text-sm">
          <span style={{ color: 'var(--text-muted)', userSelect: 'none' }}>$ </span>
          {shown.command}
        </code>
        {/* Keyed by OS, so a tab switch drops the last command's check. */}
        <CopyButton key={os ?? 'mac'} os={os ?? 'mac'} />
      </div>
      <p className="text-sm text-center" style={{ color: 'var(--text-muted)' }}>
        or get {shown.assets} from the{' '}
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="landing-github-link"
          style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap' }}
          onClick={() => trackEvent({ name: 'releases_click' })}
        >
          <span style={{ textDecoration: 'underline' }}>Releases page</span> {''}
        </a>
      </p>
    </section>
  );
}
