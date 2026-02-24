import Link from 'next/link';
import { TmuxyDemo } from '@/components/TmuxyDemo';

const features = [
  {
    title: 'Keyboard-First',
    description:
      'Full tmux keybinding support. Prefix keys, copy mode, command prompt — everything works as expected.',
    icon: '⌨',
  },
  {
    title: 'Pane Management',
    description:
      'Split, resize, drag-and-drop, and group panes. Visual layout with smooth animations.',
    icon: '⊞',
  },
  {
    title: 'Terminal Emulation',
    description:
      'Accurate ANSI rendering with cursor styles, selection, hyperlinks, and image protocols.',
    icon: '▶',
  },
  {
    title: 'Real-Time Sync',
    description:
      'WebSocket connection to tmux control mode. Every keystroke, every update — instantly reflected.',
    icon: '⚡',
  },
];

export default function Home() {
  return (
    <main className="min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-black/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="text-lg font-semibold tracking-tight text-white">
            tmuxy
          </Link>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/nickhudkins/tmuxy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-neutral-400 transition hover:text-white"
            >
              GitHub
            </a>
            <a
              href="https://github.com/nickhudkins/tmuxy/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-green-500"
            >
              Download
            </a>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 text-center">
            <div className="mb-4 flex items-center justify-center gap-3">
              <span className="rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1 text-xs text-green-400">
                Open Source
              </span>
              <span className="rounded-full border border-neutral-700 bg-neutral-800 px-3 py-1 text-xs text-neutral-400">
                MIT License
              </span>
            </div>
            <h1 className="text-5xl font-bold tracking-tight text-white md:text-6xl">
              A modern web interface
              <br />
              <span className="text-green-400">for tmux</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-neutral-400">
              Control tmux from your browser or desktop. Real-time terminal rendering, keyboard-first
              navigation, drag-and-drop pane management, and more.
            </p>
          </div>

          {/* Live demo in macOS window frame */}
          <div className="overflow-hidden rounded-xl border border-white/10 bg-neutral-900 shadow-2xl">
            <div className="flex h-8 items-center gap-2 border-b border-white/5 bg-neutral-800 px-3">
              <span className="h-3 w-3 rounded-full bg-red-500" />
              <span className="h-3 w-3 rounded-full bg-yellow-500" />
              <span className="h-3 w-3 rounded-full bg-green-500" />
              <span className="ml-2 text-xs text-neutral-500">tmuxy</span>
            </div>
            <div className="relative">
              <TmuxyDemo />
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-white/5 px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-white">
            Everything you need to control tmux
          </h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {features.map((f) => (
              <div
                key={f.title}
                className="rounded-lg border border-white/5 bg-neutral-900/50 p-6 transition hover:border-white/10"
              >
                <div className="mb-3 text-2xl">{f.icon}</div>
                <h3 className="mb-2 text-lg font-semibold text-white">{f.title}</h3>
                <p className="text-sm leading-relaxed text-neutral-400">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Open Source */}
      <section className="border-t border-white/5 px-6 py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-white">Open Source</h2>
          <p className="mb-8 text-lg text-neutral-400">
            Tmuxy is free and open source under the MIT license. Contributions welcome.
          </p>
          <a
            href="https://github.com/nickhudkins/tmuxy"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-neutral-900 px-6 py-3 font-medium text-white transition hover:bg-neutral-800"
          >
            View on GitHub
          </a>
        </div>
      </section>

      {/* Download CTA */}
      <section className="border-t border-white/5 bg-neutral-950 px-6 py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-white">Get Tmuxy</h2>
          <p className="mb-8 text-neutral-400">
            Available as a native macOS app (Tauri) or a self-hosted web server.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="https://github.com/nickhudkins/tmuxy/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-green-600 px-6 py-3 font-medium text-white transition hover:bg-green-500"
            >
              Download for macOS
            </a>
            <a
              href="https://github.com/nickhudkins/tmuxy/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-white/10 px-6 py-3 font-medium text-white transition hover:bg-neutral-800"
            >
              All Releases
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 px-6 py-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <span className="text-sm text-neutral-500">tmuxy</span>
          <div className="flex gap-6 text-sm text-neutral-500">
            <a
              href="https://github.com/nickhudkins/tmuxy"
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-white"
            >
              GitHub
            </a>
            <a
              href="https://github.com/nickhudkins/tmuxy/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-white"
            >
              Releases
            </a>
            <a
              href="https://github.com/nickhudkins/tmuxy/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-white"
            >
              MIT License
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
