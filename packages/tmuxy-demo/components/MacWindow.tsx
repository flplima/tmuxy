export function MacWindow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-xl"
      style={{
        background: 'var(--bg-black, #000)',
        boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.5))',
        minHeight: '500px',
      }}
    >
      {children}
    </div>
  );
}
