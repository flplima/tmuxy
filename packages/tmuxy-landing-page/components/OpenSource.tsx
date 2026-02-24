export function OpenSource() {
  return (
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
  );
}
