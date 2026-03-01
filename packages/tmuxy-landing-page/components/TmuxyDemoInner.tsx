'use client';

import { TmuxyProvider, TmuxyApp, DemoAdapter, type RenderTabline } from 'tmuxy-ui';
import 'tmuxy-ui/styles.css';
import { useMemo } from 'react';

const renderTabline: RenderTabline = ({ children }) => (
  <>
    <div className="flex items-center gap-1.5 shrink-0" style={{ paddingLeft: 12, paddingRight: 4 }}>
      <span className="h-3 w-3 rounded-full bg-red-500" />
      <span className="h-3 w-3 rounded-full bg-yellow-500" />
      <span className="h-3 w-3 rounded-full bg-green-500" />
    </div>
    {children}
  </>
);

const INIT_COMMANDS = [
  'split-window -h',        // vertical split → pane 1 (right), now active
  'split-window -v',        // horizontal split on right pane → pane 2 (bottom-right)
  'select-pane -t %0',      // select left pane
  'new-window',             // create tab 2
  'select-window -t @0',    // back to tab 1
];

export default function TmuxyDemoInner() {
  const adapter = useMemo(() => new DemoAdapter({ initCommands: INIT_COMMANDS }), []);

  return (
    <div style={{ height: 500, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <TmuxyProvider adapter={adapter}>
        <TmuxyApp renderTabline={renderTabline} />
      </TmuxyProvider>
    </div>
  );
}
