import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  transpilePackages: ['@tmuxy/ui'],
};

export default nextConfig;
