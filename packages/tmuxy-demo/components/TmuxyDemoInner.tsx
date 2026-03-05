'use client';

import { TmuxyProvider, TmuxyApp, WasmAdapter, useAppFocused, type RenderTabline } from 'tmuxy-ui';
import 'tmuxy-ui/styles.css';
import 'tmuxy-ui/fonts/nerd-font.css';
import { useMemo } from 'react';

function DemoTabline({ children }: { children: React.ReactNode }) {
  const appFocused = useAppFocused();
  return (
    <>
      <div className="flex items-center gap-1.5 shrink-0" style={{ paddingLeft: 12, paddingRight: 4 }}>
        <span className={`h-3 w-3 rounded-full ${appFocused ? 'bg-red-500' : 'bg-gray-500'}`} />
        <span className={`h-3 w-3 rounded-full ${appFocused ? 'bg-yellow-500' : 'bg-gray-500'}`} />
        <span className={`h-3 w-3 rounded-full ${appFocused ? 'bg-green-500' : 'bg-gray-500'}`} />
      </div>
      {children}
    </>
  );
}

const renderTabline: RenderTabline = ({ children }) => (
  <DemoTabline>{children}</DemoTabline>
);

export default function TmuxyDemoInner() {
  const adapter = useMemo(() => new WasmAdapter(), []);

  return (
    <div style={{ height: 500, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <TmuxyProvider adapter={adapter} config={{ forwardScrollToParent: true, requireFocus: true, isDemo: true }}>
        <TmuxyApp renderTabline={renderTabline} />
      </TmuxyProvider>
    </div>
  );
}
