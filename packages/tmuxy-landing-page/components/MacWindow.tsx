export function MacWindow({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl bg-neutral-900" style={{ boxShadow: '0 8px 40px rgba(0, 0, 0, 0.5)' }}>
      <div style={{ padding: '0 4px 4px' }}>
        {children}
      </div>
    </div>
  );
}
