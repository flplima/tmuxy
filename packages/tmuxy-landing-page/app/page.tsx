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
          is the missing tmux GUI you didn&apos;t know you needed.
        </p>
        <a
          href="https://github.com/flplima/tmuxy"
          target="_blank"
          rel="noopener noreferrer"
          className="landing-github-link text-sm"
          style={{ color: 'var(--text-primary)', textDecoration: 'underline' }}
        >
          {'\uF09B'} View on GitHub {'\uF08E'}
        </a>
      </div>
      <div className="w-full max-w-3xl">
        <MacWindow>
          <TmuxyDemo />
        </MacWindow>
      </div>

      <div className="w-full max-w-3xl py-16" style={{ color: 'var(--text-secondary)', textAlign: 'justify' }}>
        <h2
          className="text-2xl font-bold mb-4"
          style={{ color: 'var(--accent-green)' }}
        >
          wait, is this another terminal emulator?
        </h2>
        <p className="text-sm mb-3" style={{ lineHeight: '1.7' }}>
          No. The best terminal emulator already exists and it&apos;s{' '}
          <strong style={{ color: 'var(--text-primary)' }}>tmux</strong>.
          It emulates a full VT100/xterm terminal, multiplexes sessions that persist across
          disconnects, and has a client-server architecture battle-tested for over 15 years.
        </p>
        <p className="text-sm mb-3" style={{ lineHeight: '1.7' }}>
          Meanwhile, more stuff lives in the terminal than ever. Claude Code, Codex, Aider, they
          all run in terminal sessions. TUI tools keep replacing GUIs. tmux is what holds it together,
          because sessions persist, you can script anything, and nothing dies when you close your laptop.
        </p>
        <p className="text-sm mb-8" style={{ lineHeight: '1.7' }}>
          So.. what is missing, then? Well... if you&apos;ve tried using tmux for more than a few
          minutes, you already know the answer.
        </p>

        <h2
          className="text-2xl font-bold mb-4"
          style={{ color: 'var(--accent-green)' }}
        >
          so, what is tmuxy?
        </h2>
        <p className="text-sm mb-3" style={{ lineHeight: '1.7' }}>
          tmux was never trying to have good UX. It&apos;s a tool for people who think in keystrokes
          and shell scripts. Resizing a pane means typing a command. Swapping two panes means
          remembering which flag goes where. The interface is the terminal, and that was always enough.
        </p>
        <p className="text-sm mb-3" style={{ lineHeight: '1.7' }}>
          tmuxy gives it a browser-based GUI. It connects to a real tmux session via control mode,
          so every pane is an actual tmux pane. Your config, plugins, and scripts still work. Nothing
          is emulated.
        </p>
        <p className="text-sm mb-3" style={{ lineHeight: '1.7' }}>
          Drag headers to swap panes, dividers to resize, click tabs to switch windows. Right-click
          for context menus. Pick a theme. tmux keeps doing what it does underneath.
        </p>
        <p className="text-sm" style={{ lineHeight: '1.7' }}>
          Open the desktop app and it attaches to your local tmux server. SSH into a long-running
          session in the cloud. Install the web server on a VM and open it from your phone. You
          don&apos;t need a new IDE. You don&apos;t need to change anything. You know the workflow
          that gets your stuff done. You just need a better view into it. That&apos;s tmuxy.
        </p>
        <h2
          className="text-2xl font-bold mb-4 mt-8"
          style={{ color: 'var(--accent-green)' }}
        >
          ok, I got you. where&apos;s the download button?
        </h2>
        <p className="text-sm mb-3" style={{ lineHeight: '1.7' }}>
          There isn&apos;t one yet. tmuxy is still being built, vibe coded on my spare time.
          I haven&apos;t reviewed a single line of code that Claude has generated so far.
          It&apos;s not ready for a stable release, but if you&apos;ve read this far about a
          tmux GUI, you probably want to help build it.
        </p>
        <p className="text-sm" style={{ lineHeight: '1.7' }}>
          The code is on{' '}
          <a
            href="https://github.com/flplima/tmuxy"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link"
            style={{ color: 'var(--text-primary)', textDecoration: 'underline' }}
          >
            {'\uF09B'} GitHub {'\uF08E'}
          </a>
          {' '}and there&apos;s a full architecture walkthrough on{' '}
          <a
            href="https://deepwiki.com/flplima/tmuxy"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link"
            style={{ color: 'var(--text-primary)', textDecoration: 'underline' }}
          >
            {'\uF02D'} DeepWiki {'\uF08E'}
          </a>
          {' '}if you want to understand how things work before jumping in. Or just{' '}
          <a
            href="https://x.com/intent/tweet?url=https%3A%2F%2Ftmuxy.sh%2F"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-github-link"
            style={{ color: 'var(--text-primary)', textDecoration: 'underline' }}
          >
            share it on X {'\uF08E'}
          </a>.
        </p>
      </div>
    </main>
  );
}
