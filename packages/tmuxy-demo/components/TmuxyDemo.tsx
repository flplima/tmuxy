'use client';

import dynamic from 'next/dynamic';

export const TmuxyDemo = dynamic(() => import('./TmuxyDemoInner'), { ssr: false });
