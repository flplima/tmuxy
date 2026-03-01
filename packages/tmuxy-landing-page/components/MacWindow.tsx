export function MacWindow({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl bg-neutral-900 shadow-2xl">
      {children}
    </div>
  );
}
