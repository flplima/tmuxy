'use client';

import { useEffect, useState } from 'react';
import { MacWindow } from '@/components/MacWindow';
import { TmuxyDemo } from '@/components/TmuxyDemo';
import { trackEvent } from '@/lib/analytics';

export default function Home() {
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    document.fonts.ready.then(() => setFontsReady(true));
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-6 sm:py-12">
      <div
        className={`mb-8 w-full max-w-3xl ${fontsReady ? 'landing-fade-in' : 'landing-hidden'}`}
      >
        {/* Desktop: centered column layout */}
        <div className="hidden sm:flex flex-col items-center gap-3 text-center">
          <h1
            className="text-5xl font-bold tracking-tight"
            style={{ color: 'var(--accent-green)' }}
          >
            tmuxy
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            The missing tmux GUI you didn&apos;t know you needed
          </p>
          <a
            href="https://github.com/flplima/tmuxy"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link text-sm"
            style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap' }}
            onClick={() => trackEvent({ name: 'github_click' })}
          >
            <span style={{ textDecoration: 'underline' }}>{'\uF09B'} View on GitHub</span> {'\uF08E'}
          </a>
        </div>
        {/* Mobile: centered group — tmuxy | slogan/link */}
        <div className="flex sm:hidden items-center justify-center gap-8">
          <h1
            className="text-4xl font-bold tracking-tight"
            style={{ color: 'var(--accent-green)', flexShrink: 0 }}
          >
            tmuxy
          </h1>
          <div className="flex flex-col items-start gap-1" style={{ flexShrink: 1, minWidth: 0 }}>
            <p className="text-sm" style={{ color: 'var(--text-muted)', textWrap: 'balance' }}>
              The missing tmux GUI you didn&apos;t know you needed
            </p>
            <a
              href="https://github.com/flplima/tmuxy"
              target="_blank"
              rel="noopener noreferrer"
              className="landing-github-link text-sm"
              style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap' }}
              onClick={() => trackEvent({ name: 'github_click' })}
            >
              <span style={{ textDecoration: 'underline' }}>{'\uF09B'} View on GitHub</span> {'\uF08E'}
            </a>
          </div>
        </div>
      </div>
      <div className="w-full max-w-3xl">
        <MacWindow>
          <TmuxyDemo />
        </MacWindow>
      </div>

      <div className="w-full max-w-3xl py-16" style={{ color: 'var(--text-secondary)', textAlign: 'justify', fontSize: '0.95rem' }}>
        <h2
          className="text-2xl font-bold mb-4"
          style={{ color: 'var(--accent-green)' }}
        >
          wait, is this another terminal emulator?
        </h2>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          No. The best terminal emulator already exists: <b>It&apos;s tmux.</b>
        </p>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          tmux already solved terminal emulation, multiplexing and persistent sessions more than a decade ago.
          It plays nicely with AI agents and it's the perfect glue connecting terminal apps in this TUI renaissance we&apos;re living through.
        </p>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          So... what is missing? Well... If you&apos;ve tried to use tmux without memorizing all the
          keybindings and commands, you already know the answer.
        </p>

        <h2
          className="text-2xl font-bold mb-4 mt-8"
          style={{ color: 'var(--accent-green)' }}
        >
          so, what is tmuxy?
        </h2>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          <strong>tmuxy is a GUI for tmux.</strong>
        </p>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          The <b>desktop app</b> attaches to your local tmux server — or to a remote one via SSH.
          It&apos;s like attaching to tmux from a normal terminal emulator, but now we are wrapping
          tmux itself instead: every UI pane is an actual tmux pane.
        </p>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          The <b>web server mode</b> exposes the same UI as a web app, so you can access it from
          anywhere — including your mobile phone browser. No additional app needed.
        </p>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          Here&apos;s how it works: A Rust backend connects to tmux through{' '}
          <a
            href="https://github.com/tmux/tmux/wiki/Control-Mode"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link"
            style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap' }}
          >
            <span style={{ textDecoration: 'underline' }}>control mode</span> {'\uF08E'}
          </a>
          {' '}and streams state updates to a React frontend via SSE (or Tauri IPC, on the desktop
          app version). Being web-based allows it to support all kinds of fancy stuff like image
          rendering, markdown previews, pane groups and floating panes, while under the
          hood <strong>it&apos;s still tmux</strong>.
        </p>

        <h2
          className="text-2xl font-bold mb-4 mt-8"
          style={{ color: 'var(--accent-green)' }}
        >
          ok, I got you. where&apos;s the download button?
        </h2>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          There isn&apos;t one yet. tmuxy is fully vibe coded on spare time. I haven&apos;t
          reviewed a single line of code Claude has generated. It&apos;s not ready for a stable release.
        </p>
        <p style={{ lineHeight: '1.7' }}>
          But if you&apos;ve read this far about a tmux GUI, you probably want to help build it.
          The code is on{' '}
          <a
            href="https://github.com/flplima/tmuxy"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link"
            style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap' }}
            onClick={() => trackEvent({ name: 'github_click' })}
          >
            <span style={{ textDecoration: 'underline' }}>{'\uF09B'} GitHub</span> {'\uF08E'}
          </a>
          {' '}and there&apos;s a full architecture walkthrough on{' '}
          <a
            href="https://deepwiki.com/flplima/tmuxy"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link"
            style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap' }}
            onClick={() => trackEvent({ name: 'deepwiki_click' })}
          >
            <span style={{ textDecoration: 'underline' }}>DeepWiki</span> {'\uF08E'}
          </a>
          {' '}if you want to understand how things work before jumping in. Or you can just{' '}
          <a
            href="https://x.com/intent/tweet?url=https%3A%2F%2Ftmuxy.sh%2F"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link"
            style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap' }}
            onClick={() => trackEvent({ name: 'share_click' })}
          >
            <span style={{ textDecoration: 'underline' }}>share it on X</span> {'\uF08E'}
          </a>.
        </p>
      </div>
    </main>
  );
}
