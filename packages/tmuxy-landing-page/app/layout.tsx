import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tmuxy — A Modern Web Interface for tmux',
  description:
    'Control tmux from your browser. Real-time terminal rendering, keyboard-first navigation, pane management, and more.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
