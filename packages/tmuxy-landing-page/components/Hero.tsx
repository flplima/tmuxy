import { MacWindow } from './MacWindow';
import { TmuxyDemo } from './TmuxyDemo';

export function Hero() {
  return (
    <section className="relative overflow-hidden px-6 py-20">
      <div className="mx-auto max-w-6xl">
        {/* Headline */}
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
        <MacWindow>
          <TmuxyDemo />
        </MacWindow>
      </div>
    </section>
  );
}
