'use client';

import {
  TmuxyProvider,
  TmuxyApp,
  CheerpXTmuxAdapter,
  V86TmuxAdapter,
  GuestTransportLive,
  cheerpxAvailable,
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

const PANE_GROUP_FILES = [
  ['pane-group-1.txt', 'Did you notice that this pane has two tabs?'],
  [
    'pane-group-2.txt',
    'A pane group lets you stack several panes in the same position within your layout. The inactive panes live in hidden tmux windows.\\n\\nWhen you switch tabs, tmuxy swaps the visible pane with the hidden one.',
  ],
].map(([file, text]) => `run-shell "printf '${text}\\n' > ~/${file}"`);

// Run from the pane's own shell with the CLI: `group add` acts on the shell's
// pane. Targets name the demo's session (renamed from the guest's `m`) because
// a parked shell's own session is the stash. The switch to the welcome tab is
// the line's last step, since an init command would run before the shell got
// to it; the app waits for INIT_DONE before its first frame. Pane ids are
// whatever the guest's start left them at, so other targets are relative.
const SESSION = 'tmuxy';
const INIT_DONE = '@tmuxy-demo-ready';
const PANE_GROUP_THEN_WELCOME = [
  `send-keys -l "clear; cat ~/pane-group-1.txt; tmuxy pane group add && tmux send-keys -t ${SESSION}:features. 'clear; cat ~/pane-group-2.txt' Enter && tmuxy pane group switch \\$TMUX_PANE && tmux select-window -t ${SESSION}:welcome; tmux set -g ${INIT_DONE} 1"`,
  'send-keys Enter',
];

// Put in the guest's /mnt by the page.
const guestFiles = () => ({
  icat: new URL('/guest/icat', window.location.href),
  'tmuxy.md': new URL('/guest/tmuxy.md', window.location.href),
  'nyan-cat.gif': new URL('/guest/nyan-cat.gif', window.location.href),
});
const typeLine = (line: string) => [`send-keys -l "${line}"`, 'send-keys Enter'];

// Either guest starts with one window of two side-by-side panes (the v86
// snapshot, the CheerpX image's console relay).
const FEATURES_TAB = [
  'new-window',
  'rename-window features',
  'split-window -h',
  // Typed before the shell is up, so its output starts on the prompt's line;
  // `clear` puts the preview's marker at the start of one, where it is read.
  ...typeLine('clear; cd /mnt && tmuxy open tmuxy.md'),
  'select-pane -L',
  'split-window -v',
  ...typeLine('bash /mnt/icat /mnt/nyan-cat.gif'),
  'select-pane -U',
  ...PANE_GROUP_THEN_WELCOME,
];

const INIT_COMMANDS_DESKTOP = [
  `rename-session ${SESSION}`,
  ...PANE_GROUP_FILES,
  'rename-window welcome',
  'split-window -v',
  'select-pane -L',
  ...FEATURES_TAB,
];

const INIT_COMMANDS_MOBILE = [
  `rename-session ${SESSION}`,
  ...PANE_GROUP_FILES,
  'rename-window welcome',
  'select-layout even-vertical',
  'select-pane -U',
  ...FEATURES_TAB,
];

export default function TmuxyDemoInner() {
  const adapter = useMemo(() => {
    // The app's own phone test, so the session is built for the layout it draws.
    const isMobile = phoneMediaQuery()?.matches ?? false;
    const options = {
      initCommands: isMobile ? INIT_COMMANDS_MOBILE : INIT_COMMANDS_DESKTOP,
      initDoneOption: INIT_DONE,
      files: guestFiles(),
    };
    // CheerpX where the page can run it (`?guest=v86` asks for v86 anyway),
    // v86 everywhere else.
    const askedForV86 = new URLSearchParams(window.location.search).get('guest') === 'v86';
    return cheerpxAvailable() && !askedForV86
      ? new CheerpXTmuxAdapter(options)
      : new V86TmuxAdapter(options);
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
