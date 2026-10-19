import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  reactStrictMode: false,
  transpilePackages: ['tmuxy-ui'],
};

export default nextConfig;
