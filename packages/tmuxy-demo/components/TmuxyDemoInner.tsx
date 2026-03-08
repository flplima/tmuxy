'use client';

import { TmuxyProvider, TmuxyApp, DemoAdapter, useAppFocused, type RenderTabline } from 'tmuxy-ui';
import 'tmuxy-ui/styles.css';
import 'tmuxy-ui/fonts/nerd-font.css';
import { useMemo } from 'react';

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

const renderTabline: RenderTabline = ({ children }) => (
  <DemoTabline>{children}</DemoTabline>
);

const MARKDOWN_CONTENT = [
  '# Markdown in tmux?',
  '',
  'How is this possible?',
  '',
  'A shell command writes a widget marker +',
  'content into the pane scrollback. The frontend',
  'detects the marker and renders the appropriate',
  'widget (markdown, image, or anything you want)',
  'instead of the terminal grid.',
  '',
  'The **nyan cat GIF** on the left pane is',
  'using the same widget system.',
  'tmuxy detects a special marker in the pane',
  'content and swaps the raw terminal grid for a',
  'full image viewer — still inside tmux.',
  '',
  'The widget system is extensible: anything you',
  'can render in React, you can render in a pane.',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[shell cmd] -->|write marker| B[pane grid]',
  '  B -->|stream| C{detectWidget}',
  '  C -->|match| D[WidgetPane]',
  '  D --> E[TmuxyMarkdown]',
  '```',
].join('\n');

// Split URL into short lines (pane may be narrow); TmuxyImage joins them
const NYAN_CAT_IMAGE = [
  'https://gist.githubusercontent.com/',
  'brudnak/',
  'aba00c9a1c92d226f68e8ad8ba1e0a40/',
  'raw/nyan-cat.gif',
].join('\n');

const INIT_COMMANDS_DESKTOP = [
  // Tab 1: welcome (3-pane layout)
  'rename-window welcome',
  'split-window -h',          // %1 (right)
  'split-window -v',          // %2 (bottom-right)
  'select-pane -t %0',        // select left pane
  // Tab 2: features
  'new-window',               // @1 with %3
  'rename-window features',
  'split-window -h',          // %4 (right)
  'select-pane -t %3',        // select left
  'split-window -v',          // %5 (bottom-left)
  `write-widget %5 image ${NYAN_CAT_IMAGE}`,
  `write-widget %4 markdown ${MARKDOWN_CONTENT}`,
  // Top-left pane (%3): pane group with 2 panes running cat
  'select-pane -t %3',
  'send-keys -t %3 -l cat ~/pane-group-1.txt',
  'send-keys -t %3 Enter',
  'tmuxy-pane-group-add',     // creates %6, swaps into view; %3 goes to group
  'send-keys -l cat ~/pane-group-2.txt',       // goes to %6 (now active)
  'send-keys Enter',
  'tmuxy-pane-group-next',    // switch back to %3 visible (first tab)
  'select-window -t @0',      // back to welcome tab
];

const INIT_COMMANDS_MOBILE = [
  // Tab 1: welcome (stacked panes for narrow screens)
  'rename-window welcome',
  'split-window -v',          // %1 (bottom)
  'select-pane -t %0',        // select top pane
  // Tab 2: features (same 3-pane layout as desktop)
  'new-window',               // @1 with %2
  'rename-window features',
  'split-window -h',          // %3 (right)
  'select-pane -t %2',        // select left
  'split-window -v',          // %4 (bottom-left)
  `write-widget %4 image ${NYAN_CAT_IMAGE}`,
  `write-widget %3 markdown ${MARKDOWN_CONTENT}`,
  // Top-left pane (%2): pane group with 2 panes running cat
  'select-pane -t %2',
  'send-keys -t %2 -l cat ~/pane-group-1.txt',
  'send-keys -t %2 Enter',
  'tmuxy-pane-group-add',     // creates %5, swaps into view; %2 goes to group
  'send-keys -l cat ~/pane-group-2.txt',
  'send-keys Enter',
  'tmuxy-pane-group-next',
  'select-window -t @0',      // back to welcome tab
];

export default function TmuxyDemoInner() {
  const adapter = useMemo(() => {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
    return new DemoAdapter({ initCommands: isMobile ? INIT_COMMANDS_MOBILE : INIT_COMMANDS_DESKTOP });
  }, []);

  return (
    <div style={{ height: 500, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <TmuxyProvider adapter={adapter} config={{ forwardScrollToParent: true, requireFocus: true, isDemo: true }}>
        <TmuxyApp renderTabline={renderTabline} />
      </TmuxyProvider>
    </div>
  );
}
