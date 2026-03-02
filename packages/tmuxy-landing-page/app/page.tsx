import { MacWindow } from '@/components/MacWindow';
import { TmuxyDemo } from '@/components/TmuxyDemo';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-12">
      <div className="mb-8 flex items-baseline gap-4 flex-wrap justify-center">
        <h1
          className="text-4xl font-bold tracking-tight"
          style={{ color: 'var(--text-primary)' }}
        >
          tmuxy
        </h1>
        <span
          className="text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          The missing tmux GUI you didn&apos;t know you needed.{' '}
          <a
            href="https://github.com/flplima/tmuxy"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent-green)', textDecoration: 'none' }}
          >
            {'\uF09B'} View on GitHub {'\uF08E'}
          </a>
        </span>
      </div>
      <div className="w-full max-w-5xl">
        <MacWindow>
          <TmuxyDemo />
        </MacWindow>
      </div>
    </main>
  );
}
