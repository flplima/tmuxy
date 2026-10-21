'use client';

import {
  TmuxyProvider,
  TmuxyApp,
  V86TmuxAdapter,
  V86TransportLive,
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

// The two texts the features tab's pane group shows, written into the guest's
// home before the panes `cat` them.
const PANE_GROUP_FILES = [
  ['pane-group-1.txt', 'Did you notice that this pane has two tabs?'],
  [
    'pane-group-2.txt',
    'A pane group lets you stack several panes in the same position within your layout. The inactive panes live in hidden tmux windows.\\n\\nWhen you switch tabs, tmuxy swaps the visible pane with the hidden one.',
  ],
].map(([file, text]) => `run-shell "printf '${text}\\n' > ~/${file}"`);

// A pane group in the active pane: one member showing the first text, a second
// one the other, then back to the first, and then to the welcome tab. Run from
// the pane's own shell with the CLI, as a user would: `group add` acts on the
// shell's pane, and the new member is the one then showing in the features
// tab (`m:features.`). Targets name the snapshot's session, `m`
// (build-v86-snapshot.mjs), since a parked shell's own session is the stash.
// The switch to the welcome tab is the line's own last step rather than an
// init command, which would run before the shell got to it. Otherwise targets
// are relative: the guest's pane ids are whatever its snapshot left them at.
const PANE_GROUP_THEN_WELCOME = [
  `send-keys -l "clear; cat ~/pane-group-1.txt; tmuxy pane group add && tmux send-keys -t m:features. 'clear; cat ~/pane-group-2.txt' Enter && tmuxy pane group switch \\$TMUX_PANE && tmux select-window -t m:welcome"`,
  'send-keys Enter',
];

// The guest's snapshot starts with one window of two side-by-side panes.
const FEATURES_TAB = [
  // Tab 2: features: left column split in two, its top pane a group
  'new-window',
  'rename-window features',
  'split-window -h',
  'select-pane -L',
  'split-window -v',
  'select-pane -U',
  ...PANE_GROUP_THEN_WELCOME,
];

const INIT_COMMANDS_DESKTOP = [
  ...PANE_GROUP_FILES,
  // Tab 1: welcome: the two panes, the right one split in two
  'rename-window welcome',
  'split-window -v',
  'select-pane -L',
  ...FEATURES_TAB,
];

const INIT_COMMANDS_MOBILE = [
  ...PANE_GROUP_FILES,
  // Tab 1: welcome: the two panes stacked, for narrow screens
  'rename-window welcome',
  'select-layout even-vertical',
  'select-pane -U',
  ...FEATURES_TAB,
];

export default function TmuxyDemoInner() {
  const adapter = useMemo(() => {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
    return new V86TmuxAdapter({
      initCommands: isMobile ? INIT_COMMANDS_MOBILE : INIT_COMMANDS_DESKTOP,
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
          trackEvent({ name: 'demo_tab_switch', params: { tab_name: win.name } });
        }
      }
      lastWindowId.current = activeId;
    });
  }, [adapter]);

  const transport = useMemo(() => V86TransportLive(adapter), [adapter]);

  return (
    <div
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
