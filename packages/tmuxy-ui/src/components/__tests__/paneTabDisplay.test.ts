import { describe, it, expect } from 'vitest';
import { getTabText } from '../paneTabDisplay';
import type { TmuxPane } from '../../tmux/types';

const pane = (over: Partial<TmuxPane> = {}): TmuxPane => ({
  id: 0,
  tmuxId: '%0',
  windowId: '@0',
  content: [],
  cursorX: 0,
  cursorY: 0,
  width: 80,
  height: 24,
  x: 0,
  y: 0,
  active: false,
  command: 'zsh',
  title: '',
  // The monitor pins pane-border-format to a single space, so this arrives
  // blank-but-not-empty on every real pane.
  borderTitle: ' ',
  inMode: false,
  copyCursorX: 0,
  copyCursorY: 0,
  alternateOn: false,
  mouseAnyFlag: false,
  paused: false,
  historySize: 0,
  selectionPresent: false,
  selectionStartX: 0,
  selectionStartY: 0,
  cursorShape: 0,
  cursorHidden: false,
  ...over,
});

describe('getTabText', () => {
  it('shows the title the app announced over OSC 0/2, not the process name', () => {
    // `claude` is installed as a symlink to a version-numbered file, so
    // pane_current_command is the meaningless "2.1.251" — the app's own title
    // is the only useful label.
    expect(getTabText(pane({ command: '2.1.251', title: '✳ tmuxy' }))).toBe('✳ tmuxy');
  });

  it('falls back to the process name when no app set a title', () => {
    // The backend blanks tmux's default host-name seed, so an empty title
    // really does mean "no app title".
    expect(getTabText(pane({ command: 'nvim', title: '' }))).toBe('nvim');
  });

  it('never falls back to a blank border title', () => {
    expect(getTabText(pane({ command: '', title: '' }))).toBe('shell');
  });

  it('prefers an explicit override over the app title', () => {
    expect(getTabText(pane({ title: '✳ tmuxy' }), 'README.md')).toBe('README.md');
  });

  it('reports copy mode ahead of any title', () => {
    expect(getTabText(pane({ title: '✳ tmuxy', inMode: true }))).toBe('[COPY MODE]');
  });
});
