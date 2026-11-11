import { describe, it, expect } from 'vitest';
import { createInitialContext } from '../../../machines/app/context';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelWindow } from '../../../test/model';
import type { AppMachineContext } from '../../../machines/types/context';
import type { MenuEnv } from '../../../domain/menus/spec';
import { rank } from '../../../domain/palette/fuzzy';
import { entryText } from '../../../domain/palette/entries';
import { appMenuSpec } from '../../menus/specs/appMenu';
import { itemIds } from '../../../domain/menus/spec';
import { newSessionEntry, paletteEntries } from '../paletteEntries';

const WEB: MenuEnv = { isDemo: false, isTauri: false, isMac: false };

const BINDINGS: AppMachineContext['keybindings'] = {
  prefix_key: 'C-a',
  repeat_time_ms: 300,
  prefix_bindings: [
    { key: '-', command: 'split-window -v -c "#{pane_current_path}"', description: '' },
    { key: '|', command: 'split-window -h -c "#{pane_current_path}"', description: '' },
  ],
  root_bindings: [],
  tables: {},
};

function ctx(overrides: Partial<AppMachineContext> = {}): AppMachineContext {
  return {
    ...createInitialContext(),
    sessionName: 'work',
    keybindings: BINDINGS,
    activeWindowId: wid('@1'),
    activePaneId: pid('%1'),
    windows: [
      modelWindow(wid('@1'), 1, { name: 'editor', active: true }),
      modelWindow(wid('@2'), 2, { name: 'logs' }),
      modelWindow(wid('@9'), 9, { name: 'float', windowType: 'float' }),
    ],
    panes: [
      modelPane(pid('%1'), wid('@1'), { active: true, command: 'nvim', title: 'main.rs' }),
      modelPane(pid('%2'), wid('@2'), { active: true, command: 'tail' }),
      modelPane(pid('%8'), wid('@9'), { command: 'htop' }),
    ],
    sessions: [
      {
        sessionName: 'work',
        windows: [{ id: wid('@1'), index: 1, name: 'editor' }],
        panes: [
          {
            id: pid('%1'),
            windowId: wid('@1'),
            command: 'nvim',
            title: '',
            cwd: '/srv/api',
            active: true,
          },
        ],
      },
      {
        sessionName: 'play',
        windows: [{ id: wid('@5'), index: 1, name: 'game' }],
        panes: [
          {
            id: pid('%6'),
            windowId: wid('@5'),
            command: 'python',
            title: 'repl',
            cwd: '/tmp',
            active: true,
          },
        ],
      },
    ],
    restorableSessions: [
      { name: 'play', savedAt: 1 },
      { name: 'archive', savedAt: 2 },
    ],
    ...overrides,
  };
}

describe('paletteEntries', () => {
  const entries = paletteEntries(ctx(), WEB);
  const action = (id: string) => entries.actions.find((e) => e.id === `action:${id}`);

  it('offers both splits for "split", each with its key', () => {
    const found = rank(
      entries.actions.map((entry) => ({ entry, label: entry.label, extra: entryText(entry) })),
      'split',
    ).map((r) => r.item.entry);
    expect(found.slice(0, 2).map((e) => [e.label, e.keyHint])).toEqual([
      ['Split Pane Below', 'ctrl+a -'],
      ['Split Pane Right', 'ctrl+a |'],
    ]);
  });

  it('lists every enabled app menu item but the two that open the palette', () => {
    const spec = appMenuSpec(ctx(), WEB);
    expect(itemIds(spec)).toContain('view-palette');
    expect(action('view-palette')).toBeUndefined();
    expect(action('view-go-to')).toBeUndefined();
    expect(action('tab-new')).toMatchObject({ label: 'New Tab', detail: 'Tab' });
    expect(action('session-kill')).toMatchObject({ label: 'Kill Session', detail: 'Session' });
    expect(action('theme-mode-dark')).toMatchObject({ detail: 'View › Theme', checked: true });
    // One tab, one pane: nothing to step to, so not offered.
    expect(action('tab-next')).toBeDefined();
    expect(
      paletteEntries(ctx({ windows: [ctx().windows[0]] }), WEB).actions.map((e) => e.id),
    ).not.toContain('action:tab-next');
  });

  it('asks before the rows that end something, and before nothing else', () => {
    const asking = entries.actions.filter((e) => e.confirm).map((e) => e.id);
    expect(asking).toEqual(['action:pane-close', 'action:tab-close']);
    const desktop = paletteEntries(ctx(), { ...WEB, isTauri: true }).actions;
    expect(desktop.filter((e) => e.confirm).map((e) => e.id)).toEqual([
      'action:pane-close',
      'action:tab-close',
      'action:session-detach',
      'action:restart-app',
      'action:quit',
    ]);
    // Kill Session asks in a dialog of its own.
    expect(action('session-kill')?.confirm).toBeUndefined();
  });

  it('lists the other sessions to switch to, and the saved ones that are not running', () => {
    expect(entries.sessions.map((e) => [e.id, e.detail, e.action])).toEqual([
      [
        'session:play',
        'session',
        { kind: 'event', event: { type: 'SWITCH_SESSION', sessionName: 'play' } },
      ],
      [
        'restore:archive',
        'saved session',
        { kind: 'event', event: { type: 'RESTORE_SESSION', sessionName: 'archive' } },
      ],
    ]);
  });

  it("lists this session's tabs and panes from live state, as a click picks them", () => {
    expect(entries.tabs.slice(0, 2).map((e) => [e.label, e.detail, e.action])).toEqual([
      ['editor', 'tab 1', { kind: 'event', event: { type: 'SELECT_TAB', windowId: '@1' } }],
      ['logs', 'tab 2', { kind: 'event', event: { type: 'SELECT_TAB', windowId: '@2' } }],
    ]);
    expect(entries.panes.slice(0, 2).map((e) => [e.label, e.detail, e.keywords])).toEqual([
      ['nvim  main.rs', 'pane in editor', '/srv/api'],
      ['tail', 'pane in logs', undefined],
    ]);
    // A float is not a place in the strip.
    expect(entries.panes.map((e) => e.id)).not.toContain('pane:%8');
  });

  it("lists the other sessions' tabs and panes, to go to through a session switch", () => {
    expect(entries.tabs[2]).toMatchObject({
      id: 'tab:@5',
      label: 'game',
      detail: 'tab in play',
      action: { kind: 'event', event: { type: 'GO_TO', sessionName: 'play', windowId: '@5' } },
    });
    expect(entries.panes[2]).toMatchObject({
      id: 'pane:%6',
      label: 'python  repl',
      detail: 'pane in game, play',
      keywords: '/tmp',
      action: {
        kind: 'event',
        event: { type: 'GO_TO', sessionName: 'play', windowId: '@5', paneId: '%6' },
      },
    });
  });
});

describe('newSessionEntry', () => {
  it('offers a session named as typed, made safe', () => {
    expect(newSessionEntry(ctx(), WEB, 'side project')).toMatchObject({
      label: 'New Session “side-project”',
      confirm: true,
      action: { kind: 'event', event: { type: 'NEW_SESSION', name: 'side-project' } },
    });
  });

  it('offers none for a name a session or a snapshot has, for nothing, or in the demo', () => {
    expect(newSessionEntry(ctx(), WEB, 'work')).toBeNull();
    expect(newSessionEntry(ctx(), WEB, 'play')).toBeNull();
    expect(newSessionEntry(ctx(), WEB, 'archive')).toBeNull();
    expect(newSessionEntry(ctx(), WEB, '  ')).toBeNull();
    expect(newSessionEntry(ctx(), { ...WEB, isDemo: true }, 'fresh')).toBeNull();
  });
});
