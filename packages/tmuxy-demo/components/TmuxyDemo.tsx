'use client';

import dynamic from 'next/dynamic';

const TmuxyDemoInner = dynamic(() => import('./TmuxyDemoInner'), { ssr: false });

export function TmuxyDemo() {
  return <TmuxyDemoInner />;
}
