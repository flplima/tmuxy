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

export function Features() {
  return (
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
  );
}
