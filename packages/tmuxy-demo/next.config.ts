import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  reactStrictMode: false,
  transpilePackages: ['tmuxy-ui'],
  webpack: (config) => {
    // @lifo-sh/core uses node:module for its Node.js compat layer; not needed in browser.
    // The `node:` URI scheme requires an externals entry — resolve.fallback only handles
    // bare module names, not the `node:` protocol prefix.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      module: false,
    };
    const existingExternals = config.externals ?? [];
    const externalsArray = Array.isArray(existingExternals)
      ? existingExternals
      : [existingExternals];
    config.externals = [
      ...externalsArray,
      (
        { request }: { request?: string },
        callback: (err?: Error | null, result?: string) => void,
      ) => {
        // @lifo-sh/core conditionally imports these Node.js modules and @lifo-sh/ui
        // for its terminal attach feature, which we never call in browser mode.
        if (request === 'node:module' || request === '@lifo-sh/ui') {
          return callback(null, 'commonjs module');
        }
        callback();
      },
    ];
    return config;
  },
};

export default nextConfig;
