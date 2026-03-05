import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  basePath: '/demo',
  output: 'export',
  reactStrictMode: false,
  transpilePackages: ['tmuxy-ui'],
};

export default nextConfig;
