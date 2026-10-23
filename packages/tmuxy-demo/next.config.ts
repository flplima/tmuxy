import type { NextConfig } from 'next';

// The CheerpX guest needs SharedArrayBuffer, which only a cross-origin isolated
// page has. `next dev` sends the two headers that isolate it; the static export
// is served without them, and its page runs the v86 guest instead.
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
