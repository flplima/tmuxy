import { describe, it, expect } from 'vitest';
import { getTabText, getTabLabel, getTabIcon, splitTitleIcon } from '../paneTabDisplay';
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

describe('splitTitleIcon', () => {
  it('takes a symbol the app put in front of its own title', () => {
    expect(splitTitleIcon('\u273b claude')).toEqual({ icon: '\u273b', text: 'claude' });
    expect(splitTitleIcon('\u{1f680} deploy')).toEqual({ icon: '\u{1f680}', text: 'deploy' });
  });

  it('keeps an emoji presentation selector with the glyph it belongs to', () => {
    expect(splitTitleIcon('\u2757\ufe0f build failed')).toEqual({
      icon: '\u2757\ufe0f',
      text: 'build failed',
    });
  });

  it('leaves ordinary titles alone', () => {
    expect(splitTitleIcon('nvim README.md')).toEqual({ icon: null, text: 'nvim README.md' });
    expect(splitTitleIcon('')).toEqual({ icon: null, text: '' });
  });

  it('wants a space after it: a symbol inside a word is part of the word', () => {
    expect(splitTitleIcon('\u273bclaude')).toEqual({ icon: null, text: '\u273bclaude' });
  });

  it('leaves punctuation alone — a quoted title is a title, not an icon', () => {
    expect(splitTitleIcon('\u201c a quote')).toEqual({ icon: null, text: '\u201c a quote' });
    expect(splitTitleIcon('- a dash')).toEqual({ icon: null, text: '- a dash' });
  });

  it('is not an icon when nothing follows it', () => {
    expect(splitTitleIcon('\u273b ')).toEqual({ icon: null, text: '\u273b ' });
  });
});

describe('the icon an application announces', () => {
  it('replaces our guess rather than sitting beside it', () => {
    const claude = pane({ command: '2.1.251', title: '\u273b claude' });
    // One icon, and it is the app's own.
    expect(getTabIcon(claude)).toBe('\u273b');
    // ...and the title no longer carries it, so it is drawn once.
    expect(getTabLabel(claude)).toBe('claude');
  });

  it('falls back to the process icon when the app announced no icon', () => {
    const shell = pane({ command: 'zsh', title: 'zsh' });
    expect(getTabIcon(shell)).toBe('\ue795');
    expect(getTabLabel(shell)).toBe('zsh');
  });

  it('leaves the plain title alone for the places that draw no icon', () => {
    expect(getTabText(pane({ title: '\u273b claude' }))).toBe('\u273b claude');
  });
});
