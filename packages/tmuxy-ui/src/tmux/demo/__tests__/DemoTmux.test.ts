import { describe, it, expect, beforeEach } from 'vitest';
import { DemoTmux } from '../DemoTmux';

describe('DemoTmux', () => {
  let tmux: DemoTmux;

  beforeEach(() => {
    tmux = new DemoTmux();
    tmux.init(80, 24);
  });

  describe('initialization', () => {
    it('starts with one window and one pane', () => {
      const state = tmux.getState();
      expect(state.windows).toHaveLength(1);
      expect(state.panes).toHaveLength(1);
      expect(state.active_window_id).toBe('@0');
      expect(state.active_pane_id).toBe('%0');
    });

    it('pane has correct dimensions', () => {
      const state = tmux.getState();
      expect(state.panes[0].width).toBe(80);
      expect(state.panes[0].height).toBe(24);
    });

    it('pane has content (welcome banner)', () => {
      const state = tmux.getState();
      const content = state.panes[0].content;
      expect(content.length).toBeGreaterThan(0);
      // First line should have welcome text
      const firstLineText = content[0].map((c) => c.c).join('');
      expect(firstLineText).toContain('Welcome to tmuxy demo');
    });

    it('state has session name', () => {
      const state = tmux.getState();
      expect(state.session_name).toBe('demo');
    });
  });

  describe('split pane', () => {
    it('splits horizontally', () => {
      tmux.splitPane('horizontal');
      const state = tmux.getState();
      expect(state.panes).toHaveLength(2);
      expect(state.active_pane_id).toBe('%1');
    });

    it('splits vertically', () => {
      tmux.splitPane('vertical');
      const state = tmux.getState();
      expect(state.panes).toHaveLength(2);
    });

    it('panes have correct positions after vertical split', () => {
      tmux.splitPane('vertical');
      const state = tmux.getState();
      const pane0 = state.panes.find((p) => p.tmux_id === '%0')!;
      const pane1 = state.panes.find((p) => p.tmux_id === '%1')!;
      expect(pane0.x).toBe(0);
      expect(pane1.x).toBeGreaterThan(0);
    });

    it('panes have correct positions after horizontal split', () => {
      tmux.splitPane('horizontal');
      const state = tmux.getState();
      const pane0 = state.panes.find((p) => p.tmux_id === '%0')!;
      const pane1 = state.panes.find((p) => p.tmux_id === '%1')!;
      expect(pane0.y).toBe(0);
      expect(pane1.y).toBeGreaterThan(0);
    });

    it('can split multiple times', () => {
      tmux.splitPane('vertical');
      tmux.splitPane('horizontal');
      const state = tmux.getState();
      expect(state.panes).toHaveLength(3);
    });
  });

  describe('kill pane', () => {
    it('kills active pane', () => {
      tmux.splitPane('vertical');
      expect(tmux.getState().panes).toHaveLength(2);
      tmux.killPane();
      expect(tmux.getState().panes).toHaveLength(1);
    });

    it('kills specific pane', () => {
      tmux.splitPane('vertical');
      tmux.killPane('%0');
      const state = tmux.getState();
      expect(state.panes).toHaveLength(1);
      expect(state.panes[0].tmux_id).toBe('%1');
    });

    it('killing last pane in window kills the window and creates a new one', () => {
      const state0 = tmux.getState();
      expect(state0.windows).toHaveLength(1);
      tmux.killPane();
      const state1 = tmux.getState();
      // Should still have one window (a new one was created)
      expect(state1.windows).toHaveLength(1);
      expect(state1.panes).toHaveLength(1);
    });
  });

  describe('window management', () => {
    it('creates new window', () => {
      tmux.newWindow();
      const state = tmux.getState();
      expect(state.windows).toHaveLength(2);
      expect(state.active_window_id).toBe('@1');
    });

    it('selects window by ID', () => {
      tmux.newWindow();
      tmux.selectWindow('@0');
      expect(tmux.getState().active_window_id).toBe('@0');
    });

    it('navigates to next window', () => {
      tmux.newWindow();
      tmux.selectWindow('@0');
      tmux.nextWindow();
      expect(tmux.getState().active_window_id).toBe('@1');
    });

    it('navigates to previous window', () => {
      tmux.newWindow();
      tmux.previousWindow();
      expect(tmux.getState().active_window_id).toBe('@0');
    });

    it('next window wraps around', () => {
      tmux.newWindow();
      tmux.nextWindow();
      expect(tmux.getState().active_window_id).toBe('@0');
    });

    it('kills window', () => {
      tmux.newWindow();
      tmux.killWindow('@0');
      const state = tmux.getState();
      expect(state.windows).toHaveLength(1);
      expect(state.active_window_id).toBe('@1');
    });

    it('only shows panes from active window', () => {
      tmux.splitPane('vertical');
      expect(tmux.getState().panes).toHaveLength(2);
      tmux.newWindow();
      // New window only has 1 pane
      expect(tmux.getState().panes).toHaveLength(1);
      // Switch back
      tmux.selectWindow('@0');
      expect(tmux.getState().panes).toHaveLength(2);
    });
  });

  describe('pane selection', () => {
    it('selects pane by ID', () => {
      tmux.splitPane('vertical');
      tmux.selectPane('%0');
      expect(tmux.getState().active_pane_id).toBe('%0');
    });

    it('selects pane by direction', () => {
      tmux.splitPane('vertical');
      tmux.selectPane('%0');
      tmux.selectPaneByDirection('Right');
      expect(tmux.getState().active_pane_id).toBe('%1');
    });
  });

  describe('resize', () => {
    it('setSize updates total dimensions', () => {
      tmux.setSize(120, 40);
      const state = tmux.getState();
      expect(state.total_width).toBe(120);
      expect(state.total_height).toBe(40);
    });

    it('setSize resizes panes', () => {
      tmux.setSize(120, 40);
      const state = tmux.getState();
      expect(state.panes[0].width).toBe(120);
      expect(state.panes[0].height).toBe(40);
    });
  });

  describe('key input', () => {
    it('sends keys to active pane', () => {
      tmux.sendKey('l');
      tmux.sendKey('s');
      tmux.sendKey('Enter');
      const state = tmux.getState();
      // Pane should have updated content
      const text = state.panes[0].content
        .map((line) =>
          line
            .map((c) => c.c)
            .join('')
            .trimEnd(),
        )
        .join('\n');
      expect(text).toContain('projects');
    });

    it('sends literal text', () => {
      tmux.sendLiteral('echo hi');
      tmux.sendKey('Enter');
      const state = tmux.getState();
      const text = state.panes[0].content
        .map((line) =>
          line
            .map((c) => c.c)
            .join('')
            .trimEnd(),
        )
        .join('\n');
      expect(text).toContain('hi');
    });
  });

  describe('state serialization', () => {
    it('produces valid ServerState shape', () => {
      const state = tmux.getState();
      expect(state).toHaveProperty('session_name');
      expect(state).toHaveProperty('active_window_id');
      expect(state).toHaveProperty('active_pane_id');
      expect(state).toHaveProperty('panes');
      expect(state).toHaveProperty('windows');
      expect(state).toHaveProperty('total_width');
      expect(state).toHaveProperty('total_height');
      expect(state).toHaveProperty('status_line');
    });

    it('panes have required fields', () => {
      const pane = tmux.getState().panes[0];
      expect(pane).toHaveProperty('id');
      expect(pane).toHaveProperty('tmux_id');
      expect(pane).toHaveProperty('window_id');
      expect(pane).toHaveProperty('content');
      expect(pane).toHaveProperty('cursor_x');
      expect(pane).toHaveProperty('cursor_y');
      expect(pane).toHaveProperty('width');
      expect(pane).toHaveProperty('height');
      expect(pane).toHaveProperty('x');
      expect(pane).toHaveProperty('y');
      expect(pane).toHaveProperty('active');
      expect(pane).toHaveProperty('command');
    });

    it('windows have required fields', () => {
      const win = tmux.getState().windows[0];
      expect(win).toHaveProperty('id');
      expect(win).toHaveProperty('index');
      expect(win).toHaveProperty('name');
      expect(win).toHaveProperty('active');
      expect(win).toHaveProperty('is_pane_group_window');
    });
  });
});
