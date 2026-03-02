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
  'Tmuxy renders **markdown documents**',
  'inside terminal panes.',
  '',
  '## Features',
  '',
  '- GitHub Flavored Markdown',
  '- Code blocks with syntax highlighting',
  '- Mermaid diagrams',
  '- Live-updating content',
  '',
  '```js',
  'const greeting = "Hello, tmuxy!";',
  'console.log(greeting);',
  '```',
  '',
  '| Feature | Status |',
  '|---------|--------|',
  '| GFM | :white_check_mark: |',
  '| Code blocks | :white_check_mark: |',
  '| Mermaid | :white_check_mark: |',
].join('\n');

const NYAN_CAT_URL = 'https://upload.wikimedia.org/wikipedia/en/e/ed/Nyan_cat_250px_frame.PNG';

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
  `write-widget %5 image ${NYAN_CAT_URL}`,
  `write-widget %4 markdown ${MARKDOWN_CONTENT}`,
  'select-pane -t %3',        // select top-left (empty shell)
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
