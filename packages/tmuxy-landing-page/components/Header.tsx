import Link from 'next/link';

export function Header() {
  return (
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
  );
}
