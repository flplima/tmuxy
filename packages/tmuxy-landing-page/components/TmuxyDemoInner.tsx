'use client';

import { TmuxyProvider, TmuxyApp, DemoAdapter } from 'tmuxy-ui';
import 'tmuxy-ui/styles.css';
import { useMemo } from 'react';

export default function TmuxyDemoInner() {
  const adapter = useMemo(() => new DemoAdapter(), []);

  return (
    <div style={{ height: 500, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <TmuxyProvider adapter={adapter}>
        <TmuxyApp />
      </TmuxyProvider>
    </div>
  );
}
