export function Footer() {
  return (
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
  );
}
