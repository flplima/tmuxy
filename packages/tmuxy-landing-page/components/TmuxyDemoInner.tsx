'use client';

import { TmuxyProvider, TmuxyApp, DemoAdapter, type RenderTabline } from 'tmuxy-ui';
import 'tmuxy-ui/styles.css';
import { useMemo } from 'react';

const renderTabline: RenderTabline = ({ children }) => (
  <>
    <div className="flex items-center gap-1.5 px-2 shrink-0">
      <span className="h-3 w-3 rounded-full bg-red-500" />
      <span className="h-3 w-3 rounded-full bg-yellow-500" />
      <span className="h-3 w-3 rounded-full bg-green-500" />
    </div>
    {children}
  </>
);

export default function TmuxyDemoInner() {
  const adapter = useMemo(() => new DemoAdapter(), []);

  return (
    <div style={{ height: 500, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <TmuxyProvider adapter={adapter}>
        <TmuxyApp renderTabline={renderTabline} />
      </TmuxyProvider>
    </div>
  );
}
