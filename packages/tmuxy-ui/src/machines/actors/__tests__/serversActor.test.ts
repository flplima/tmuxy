import { describe, it, expect } from 'vitest';
import { parseSessions, toServerInfos } from '../serversActor';

// Rows are tab-joined, matching the `-F` format the actor sends.
const row = (...fields: string[]) => fields.join('\t');

describe('parseSessions', () => {
  it('groups windows and panes under their sessions, index-ordered', () => {
    const windows = [
      row('work', '@1', '1', 'editor', 'tab'),
      row('work', '@0', '0', 'shell', 'tab'),
      row('logs', '@5', '0', 'tail', 'tab'),
    ].join('\n');
    const panes = [
      row('work', '@0', '%0', 'bash', '1'),
      row('work', '@1', '%1', 'nvim', '1'),
      row('logs', '@5', '%9', 'less', '0'),
    ].join('\n');

    const sessions = parseSessions(windows, panes);
    // Sessions are name-sorted: logs, work.
    expect(sessions.map((s) => s.sessionName)).toEqual(['logs', 'work']);
    const work = sessions.find((s) => s.sessionName === 'work');
    expect(work?.windows.map((w) => w.index)).toEqual([0, 1]); // index-ordered
    expect(work?.panes.map((p) => p.id)).toEqual(['%0', '%1']);
    expect(work?.panes.find((p) => p.id === '%1')?.command).toBe('nvim');
  });

  it('keeps foreign (untagged) windows but drops tmuxy-internal ones', () => {
    const windows = [
      row('main', '@0', '0', 'work', ''), // vanilla tmux window — no type
      row('main', '@1', '1', 'float', 'float'),
      row('main', '@2', '2', 'grp', 'group'),
      row('main', '@3', '3', 'bar', 'float-backdrop'),
      row('main', '@4', '4', 'side', 'sidebar'),
    ].join('\n');
    const panes = [
      row('main', '@0', '%0', 'zsh', '1'),
      row('main', '@1', '%1', 'fzf', '1'), // pane in a hidden window → dropped
    ].join('\n');

    const [session] = parseSessions(windows, panes);
    expect(session.windows.map((w) => w.id)).toEqual(['@0']);
    expect(session.panes.map((p) => p.id)).toEqual(['%0']);
  });

  it('is resilient to empty output', () => {
    expect(parseSessions('', '')).toEqual([]);
  });

  it('marks the active pane', () => {
    const [session] = parseSessions(
      row('s', '@0', '0', 'w', 'tab'),
      [row('s', '@0', '%0', 'bash', '0'), row('s', '@0', '%1', 'top', '1')].join('\n'),
    );
    expect(session.panes.find((p) => p.id === '%1')?.active).toBe(true);
    expect(session.panes.find((p) => p.id === '%0')?.active).toBe(false);
  });
});

describe('toServerInfos', () => {
  it('normalizes the list_servers payload and defaults the label + kind', () => {
    const infos = toServerInfos({
      currentId: 'localhost',
      servers: [
        { id: 'localhost', label: 'localhost', kind: 'local' },
        { id: 'ssh-box', label: 'felipe@box', kind: 'ssh' },
        { id: 'bare' }, // no label/kind → label falls back to id, kind to local
      ],
    });
    expect(infos).toEqual([
      { id: 'localhost', label: 'localhost', kind: 'local' },
      { id: 'ssh-box', label: 'felipe@box', kind: 'ssh' },
      { id: 'bare', label: 'bare', kind: 'local' },
    ]);
  });

  it('drops entries without an id and tolerates missing payloads', () => {
    expect(toServerInfos({ servers: [{ label: 'x' }] })).toEqual([]);
    expect(toServerInfos(null)).toEqual([]);
    expect(toServerInfos(undefined)).toEqual([]);
    expect(toServerInfos({})).toEqual([]);
  });
});
