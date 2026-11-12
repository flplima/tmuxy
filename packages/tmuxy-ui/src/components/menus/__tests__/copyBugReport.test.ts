import { describe, expect, it } from 'vitest';
import { bugReportSnippet } from '../copyBugReport';
import { createInitialContext } from '../../../machines/app/context';
import type { AppMachineContext } from '../../../machines/types/context';

const facts = { tmuxy: '0.1.6', tmux: '3.5a', app: 'web' as const, os: 'Linux' };

/** A context full of what a terminal holds: none of it may reach the snippet. */
function busyContext(): AppMachineContext {
  const ctx = createInitialContext();
  return {
    ...ctx,
    sessionName: 'secret-session',
    themeName: 'nord',
    themeMode: 'dark',
    cursorBlink: true,
    sendAsk: false,
    transparency: true,
    traceSettings: {
      enabled: true,
      level: 'shape',
      path: '/home/someone/trace.ndjson',
      locked: false,
    },
    windows: [
      { id: '@1', index: 1, name: 'payroll-db', active: true, windowType: null },
      { id: '@2', index: 2, name: 'ssh prod-host', active: false, windowType: null },
    ] as unknown as AppMachineContext['windows'],
    panes: [
      { tmuxId: '%1', windowId: '@1', command: 'psql', title: 'prod-host:/srv/app' },
      { tmuxId: '%2', windowId: '@2', command: 'ssh', title: 'root@10.0.0.7' },
    ] as unknown as AppMachineContext['panes'],
  };
}

describe('the bug report snippet', () => {
  it('says the versions, the platform and the settings', () => {
    const text = bugReportSnippet(busyContext(), facts);
    expect(text).toContain('- tmuxy 0.1.6 (web)');
    expect(text).toContain('- tmux 3.5a');
    expect(text).toContain('- Linux');
    expect(text).toContain('- theme: nord (dark)');
    expect(text).toContain('cursor blink on, ask before sending keys off, transparency on');
    expect(text).toContain('- traces: on, shape');
    expect(text).toContain('- 2 tab(s), 2 pane(s)');
  });

  it('holds nothing a terminal holds: no names, commands, titles, paths or hosts', () => {
    const text = bugReportSnippet(busyContext(), facts);
    for (const held of [
      'secret-session',
      'payroll-db',
      'prod-host',
      'psql',
      'ssh',
      '10.0.0.7',
      '/srv/app',
      '/home/someone',
      'trace.ndjson',
    ]) {
      expect(text).not.toContain(held);
    }
  });
});
