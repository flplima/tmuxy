import { MacWindow } from '@/components/MacWindow';
import { TmuxyDemo } from '@/components/TmuxyDemo';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-12">
      <h1 className="mb-8 text-4xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>tmuxy</h1>
      <div className="w-full max-w-5xl">
        <MacWindow>
          <TmuxyDemo />
        </MacWindow>
      </div>
    </main>
  );
}
