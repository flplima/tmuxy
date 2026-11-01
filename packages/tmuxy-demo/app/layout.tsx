import type { Metadata } from 'next';
import Script from 'next/script';
import { GoogleAnalytics } from '@next/third-parties/google';
import './globals.css';

const SITE_URL = 'https://tmuxy.sh';
const TITLE = 'tmuxy – The missing tmux GUI';
const DESCRIPTION =
  'A modern web interface for tmux. Watch AI agents work in real-time, manage sessions from anywhere, and get a smoother terminal UX — without leaving tmux.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  // The docs for agents, built from docs/ by scripts/agent-docs.mjs.
  alternates: {
    types: { 'text/plain': '/llms-full.txt', 'application/json': '/search.json' },
  },
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

const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

const DEMO_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cxrtnc.leaningtech.com https://*.googletagmanager.com blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.google-analytics.com https://*.googletagmanager.com",
  "font-src 'self' data:",
  "connect-src 'self' https://cxrtnc.leaningtech.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com blob: data:",
  "worker-src 'self' blob: https://cxrtnc.leaningtech.com",
  "frame-src 'self' blob: https://cxrtnc.leaningtech.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark theme-dark">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={DEMO_CSP} />
      </head>
      <body className="antialiased">
        {/* Before the demo loads: it waits on this to choose its guest. */}
        <Script src="/coi-register.js" strategy="beforeInteractive" />
        {children}
      </body>
      {GA_ID && <GoogleAnalytics gaId={GA_ID} />}
    </html>
  );
}
