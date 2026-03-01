export function MacWindow({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl" style={{ background: '#000', boxShadow: '0 8px 40px rgba(0, 0, 0, 0.5)' }}>
      {children}
    </div>
  );
}
