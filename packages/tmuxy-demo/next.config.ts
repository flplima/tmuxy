import type { NextConfig } from 'next';

// In dev the Rust server proxies /demo/* → Next.js, so we need basePath.
// In production (GitHub Pages static export) the site lives at root — no basePath.
const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
  basePath: isDev ? '/demo' : '',
  output: 'export',
  reactStrictMode: false,
  transpilePackages: ['tmuxy-ui'],
};

export default nextConfig;
