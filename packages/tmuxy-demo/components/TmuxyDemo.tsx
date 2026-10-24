'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const TmuxyDemoInner = dynamic(() => import('./TmuxyDemoInner'), { ssr: false });

declare global {
  interface Window {
    /** Set by public/coi-register.js while it makes the page cross-origin
     *  isolated; pending until it knows which guest the page can run. */
    __tmuxyIsolation?: Promise<void>;
  }
}

export function TmuxyDemo() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void (window.__tmuxyIsolation ?? Promise.resolve()).then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  return ready ? <TmuxyDemoInner /> : null;
}
