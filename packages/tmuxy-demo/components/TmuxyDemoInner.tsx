'use client';

import {
  TmuxyProvider,
  TmuxyApp,
  CheerpXTmuxAdapter,
  V86TmuxAdapter,
  GuestTransportLive,
  cheerpxAvailable,
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
// tab (`tmuxy:features.`). Targets name the demo's session, which the
// init renames from the guest's `m` (build-v86-snapshot.mjs, tmuxy-console),
// since a parked shell's own session is the stash.
// The switch to the welcome tab is the line's own last step rather than an
// init command, which would run before the shell got to it, and the line ends
// by setting INIT_DONE, which the app waits for before its first frame.
// Otherwise targets are relative: the guest's pane ids are whatever its start
// left them at.
const SESSION = 'tmuxy';
const INIT_DONE = '@tmuxy-demo-ready';
const PANE_GROUP_THEN_WELCOME = [
  `send-keys -l "clear; cat ~/pane-group-1.txt; tmuxy pane group add && tmux send-keys -t ${SESSION}:features. 'clear; cat ~/pane-group-2.txt' Enter && tmuxy pane group switch \\$TMUX_PANE && tmux select-window -t ${SESSION}:welcome; tmux set -g ${INIT_DONE} 1"`,
  'send-keys Enter',
];

// What the features tab's other two panes show, from files the page puts in
// the guest's /mnt: the old demo's nyan cat, drawn with the Kitty graphics
// protocol (public/guest/icat), and a markdown document in a preview.
const guestFiles = () => ({
  icat: new URL('/guest/icat', window.location.href),
  'tmuxy.md': new URL('/guest/tmuxy.md', window.location.href),
  'nyan-cat.gif': new URL(
    'https://gist.githubusercontent.com/brudnak/aba00c9a1c92d226f68e8ad8ba1e0a40/raw/nyan-cat.gif',
  ),
});
const typeLine = (line: string) => [`send-keys -l "${line}"`, 'send-keys Enter'];

// Either guest starts with one window of two side-by-side panes (the v86
// snapshot, the CheerpX image's console relay).
const FEATURES_TAB = [
  // Tab 2: features: left column split in two, its top pane a group, the
  // nyan cat under it and the markdown on the right
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
  // Tab 1: welcome: the two panes, the right one split in two
  'rename-window welcome',
  'split-window -v',
  'select-pane -L',
  ...FEATURES_TAB,
];

const INIT_COMMANDS_MOBILE = [
  `rename-session ${SESSION}`,
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
          trackEvent({ name: 'demo_tab_switch', params: { tab_name: win.name } });
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
