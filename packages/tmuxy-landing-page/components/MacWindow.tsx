export function MacWindow({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-neutral-900 shadow-2xl">
      {/* macOS title bar */}
      <div className="flex h-8 items-center gap-2 border-b border-white/5 bg-neutral-800 px-3">
        <span className="h-3 w-3 rounded-full bg-red-500" />
        <span className="h-3 w-3 rounded-full bg-yellow-500" />
        <span className="h-3 w-3 rounded-full bg-green-500" />
        <span className="ml-2 text-xs text-neutral-500">tmuxy</span>
      </div>
      {/* Content */}
      <div className="relative">{children}</div>
    </div>
  );
}
