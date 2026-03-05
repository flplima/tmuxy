import type { Metadata } from 'next';
import './globals.css';

const SITE_URL = 'https://tmuxy.sh';
const TITLE = 'tmuxy – The missing tmux GUI';
const DESCRIPTION =
  'A modern web interface for tmux. Watch AI agents work in real-time, manage sessions from anywhere, and get a smoother terminal UX — without leaving tmux.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  openGraph: {
    type: 'website',
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'tmuxy',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'tmuxy – A modern web interface for tmux',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og-image.png'],
  },
  keywords: ['tmux', 'terminal', 'web interface', 'devtools', 'AI agents', 'remote terminal'],
  authors: [{ name: 'tmuxy' }],
  robots: 'index, follow',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark theme-dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
