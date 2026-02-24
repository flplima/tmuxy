export function DownloadCTA() {
  return (
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
  );
}
