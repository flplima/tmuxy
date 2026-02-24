'use client';

import dynamic from 'next/dynamic';

const TmuxyDemoClient = dynamic(() => import('./TmuxyDemoClient'), { ssr: false });

export function TmuxyDemo() {
  return <TmuxyDemoClient />;
}
