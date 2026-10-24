import type { NextConfig } from 'next';

// The CheerpX guest needs SharedArrayBuffer, which only a cross-origin isolated
// page has. `next dev` sends the two headers that isolate it. The static export
// is served by a host that sends no headers of its own (GitHub Pages), so there
// a service worker adds them (public/coi-sw.js, registered by coi-register.js).
const crossOriginIsolation = async () => [
  {
    source: '/:path*',
    headers: [
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
    ],
  },
];

const nextConfig: NextConfig = {
  output: 'export',
  reactStrictMode: false,
  transpilePackages: ['tmuxy-ui'],
  ...(process.env.NODE_ENV === 'development' ? { headers: crossOriginIsolation } : {}),
};

export default nextConfig;
