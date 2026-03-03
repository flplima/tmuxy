'use client';

import { useEffect, useState } from 'react';
import { MacWindow } from '@/components/MacWindow';
import { TmuxyDemo } from '@/components/TmuxyDemo';

export default function Home() {
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    document.fonts.ready.then(() => setFontsReady(true));
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-12">
      <div
        className={`mb-8 flex flex-col items-center gap-3 text-center ${fontsReady ? 'landing-fade-in' : 'landing-hidden'}`}
      >
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
          style={{ color: 'var(--text-primary)' }}
        >
          <span style={{ textDecoration: 'underline' }}>{'\uF09B'} View on GitHub</span> {'\uF08E'}
        </a>
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
          tmux already solved terminal emulation, multiplexing, persistent sessions. It has a
          client-server architecture battle-tested for over 15 years. It plays nicely with AI agents
          and it is the glue to connect all terminal apps in this TUI renaissance we&apos;re living through.
        </p>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          So... what is missing? Well... If you&apos;ve tried to use tmux for more than a few minutes,
          you already know the answer.
        </p>

        <h2
          className="text-2xl font-bold mb-4 mt-8"
          style={{ color: 'var(--accent-green)' }}
        >
          so, what is tmuxy?
        </h2>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          tmuxy is a GUI for tmux.
        </p>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          Every pane is an actual tmux pane. Using a Rust backend, it connects to tmux through
          control mode (tmux -CC) and streams state updates to a React frontend via SSE (or Tauri
          IPC, on the desktop app version).
        </p>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          Open the tmuxy desktop app and it attaches to your local tmux server. Need to connect to
          a VM? No problem. It can talk with your server&apos;s tmux via ssh.
          Want to vibe code from your phone? Just start the tmuxy web server and access it from
          your mobile browser. No additional app needed.
        </p>
        <p className="mb-3" style={{ lineHeight: '1.7' }}>
          You don&apos;t need a new IDE. You already know the workflow to get your stuff done.
          tmuxy just gives you a better view into it.
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
            style={{ color: 'var(--text-primary)' }}
          >
            <span style={{ textDecoration: 'underline' }}>{'\uF09B'} GitHub</span> {'\uF08E'}
          </a>
          {' '}and there&apos;s a full architecture walkthrough on{' '}
          <a
            href="https://deepwiki.com/flplima/tmuxy"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link"
            style={{ color: 'var(--text-primary)' }}
          >
            <span style={{ textDecoration: 'underline' }}>DeepWiki</span> {'\uF08E'}
          </a>
          {' '}if you want to understand how things work before jumping in. Or you can just{' '}
          <a
            href="https://x.com/intent/tweet?url=https%3A%2F%2Ftmuxy.sh%2F"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link"
            style={{ color: 'var(--text-primary)' }}
          >
            <span style={{ textDecoration: 'underline' }}>share it on X</span> {'\uF08E'}
          </a>.
        </p>
      </div>
    </main>
  );
}
