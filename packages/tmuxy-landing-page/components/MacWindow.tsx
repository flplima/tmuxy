export function MacWindow({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl" style={{ background: 'var(--bg-black)', boxShadow: 'var(--shadow-lg)' }}>
      {children}
    </div>
  );
}
