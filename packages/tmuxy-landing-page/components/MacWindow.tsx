export function MacWindow({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-neutral-900 shadow-2xl p-1">
      {children}
    </div>
  );
}
