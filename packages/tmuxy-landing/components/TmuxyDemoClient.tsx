'use client';

import { TmuxyProvider, TmuxyApp, FakeTmuxAdapter } from '@tmuxy/ui';
import '@tmuxy/ui/styles.css';
import { useMemo } from 'react';

export default function TmuxyDemoClient() {
  const adapter = useMemo(() => new FakeTmuxAdapter(), []);

  return (
    <div style={{ height: 500, position: 'relative' }}>
      <TmuxyProvider adapter={adapter}>
        <TmuxyApp />
      </TmuxyProvider>
    </div>
  );
}
