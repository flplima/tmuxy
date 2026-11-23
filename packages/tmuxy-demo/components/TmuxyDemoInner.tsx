'use client';

import {
  TmuxyProvider,
  TmuxyApp,
  V86TmuxAdapter,
  GuestTransportLive,
  phoneMediaQuery,
  useAppFocused,
  type RenderTabline,
} from 'tmuxy-ui';
import 'tmuxy-ui/styles.css';
import 'tmuxy-ui/fonts/nerd-font.css';
import { useEffect, useMemo, useRef } from 'react';
import { trackEvent } from '@/lib/analytics';

function DemoTabline({ children }: { children: React.ReactNode }) {
  const appFocused = useAppFocused();
  return (
    <>
      <div className="flex items-center gap-1.5 shrink-0" style={{ paddingRight: 4 }}>
        <span className={`h-3 w-3 rounded-full ${appFocused ? 'bg-red-500' : 'bg-gray-500'}`} />
        <span className={`h-3 w-3 rounded-full ${appFocused ? 'bg-yellow-500' : 'bg-gray-500'}`} />
        <span className={`h-3 w-3 rounded-full ${appFocused ? 'bg-green-500' : 'bg-gray-500'}`} />
      </div>
      {children}
    </>
  );
}

const renderTabline: RenderTabline = ({ children }) => <DemoTabline>{children}</DemoTabline>;

// The demo's snapshot holds its finished session, built when the guest's
// snapshots are (`tmuxy-ui/scripts/demo-showcase`): a `welcome` tab of two
// panes side by side, the right one active, and a `features` tab. Only the
// first tab's layout depends on the device: these run over control mode as the
// app attaches, before the first state it draws.
const LAYOUT_DESKTOP = ['split-window -v -t :welcome', 'select-pane -L -t :welcome'];
const LAYOUT_PHONE = ['select-layout -t :welcome even-vertical', 'select-pane -U -t :welcome'];

export default function TmuxyDemoInner() {
  const demoBox = useRef<HTMLDivElement>(null);
  const adapter = useMemo(() => {
    // The app's own phone test, so the session is built for the layout it draws.
    const isMobile = phoneMediaQuery()?.matches ?? false;
    return new V86TmuxAdapter({
      snapshot: 'demo',
      initCommands: isMobile ? LAYOUT_PHONE : LAYOUT_DESKTOP,
      // The machine stops while nobody looks at the demo (scrolled away, tab hidden).
      pauseWhenHidden: { target: () => demoBox.current },
    });
  }, []);

  const interacted = useRef(false);
  const lastWindowId = useRef<string | null>(null);

  useEffect(() => {
    return adapter.events.subscribe((event) => {
      if (event._tag !== 'State') return;
      const { state } = event;
      const activeId = state.active_window_id;
      if (lastWindowId.current !== null && activeId !== lastWindowId.current) {
        const win = state.windows.find((w) => w.id === activeId);
        if (win && win.window_type === 'tab') {
          const tabBucket = win.name === 'welcome' || win.name === 'features' ? win.name : 'custom';
          trackEvent({ name: 'demo_tab_switch', params: { tab_name: tabBucket } });
        }
      }
      lastWindowId.current = activeId;
    });
  }, [adapter]);

  const transport = useMemo(() => GuestTransportLive(adapter), [adapter]);

  return (
    <div
      ref={demoBox}
      style={{ height: 500, position: 'relative', display: 'flex', flexDirection: 'column' }}
      onClick={(e) => {
        if (!interacted.current) {
          interacted.current = true;
          trackEvent({ name: 'demo_interact' });
        }
        const target = e.target as HTMLElement;
        if (target.closest('.pane-tab')) {
          trackEvent({ name: 'demo_pane_group_click' });
        }
      }}
    >
      <TmuxyProvider
        transport={transport}
        config={{ forwardScrollToParent: true, requireFocus: true, isDemo: true }}
      >
        <TmuxyApp renderTabline={renderTabline} />
      </TmuxyProvider>
    </div>
  );
}
