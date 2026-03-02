'use client';

import { TmuxyProvider, TmuxyApp, DemoAdapter, useAppFocused, type RenderTabline } from 'tmuxy-ui';
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

const MARKDOWN_CONTENT = [
  '# Markdown Widget',
  '',
  'How is this possible?? Is it still tmux?',
  '',
  '**Yes, it is.** Tmuxy renders rich markdown',
  'directly inside tmux panes. The terminal',
  'content is replaced with a React component',
  'that renders GitHub Flavored Markdown —',
  'headings, bold, tables, code blocks, and more.',
  '',
  'The pane on the left is displaying an **animated',
  'nyan cat GIF** using the same widget system.',
  'Tmuxy detects a special marker in the pane',
  'content and swaps the raw terminal grid for a',
  'full image viewer — still inside tmux.',
  '',
  '## How It Works',
  '',
  'A shell command writes a widget marker +',
  'content into the pane scrollback. The frontend',
  'detects the marker and renders the appropriate',
  'widget (markdown, image, or any custom one)',
  'instead of the terminal grid.',
  '',
  '## What This Enables',
  '',
  '- **Documentation panes** — READMEs, changelogs,',
  '  runbooks rendered inline while you work',
  '- **Image previews** — screenshots, diagrams,',
  '  charts, GIFs right next to your code',
  '- **Dashboards** — live-updating markdown with',
  '  tables, metrics, and status indicators',
  '- **Custom widgets** — register any React',
  '  component as a tmux pane widget',
  '',
  'The widget system is extensible: anything you',
  'can render in React, you can render in a pane.',
].join('\n');

// Split URL into short lines (pane may be narrow); TmuxyImage joins them
const NYAN_CAT_IMAGE = [
  'https://gist.githubusercontent.com/',
  'brudnak/',
  'aba00c9a1c92d226f68e8ad8ba1e0a40/',
  'raw/nyan-cat.gif',
].join('\n');

const INIT_COMMANDS = [
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

export default function TmuxyDemoInner() {
  const adapter = useMemo(() => new DemoAdapter({ initCommands: INIT_COMMANDS }), []);

  return (
    <div style={{ height: 500, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <TmuxyProvider adapter={adapter} config={{ forwardScrollToParent: true, requireFocus: true }}>
        <TmuxyApp renderTabline={renderTabline} />
      </TmuxyProvider>
    </div>
  );
}
