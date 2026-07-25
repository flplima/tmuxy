import { describe, it, expect, vi } from 'vitest';
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import type { TmuxAdapter } from '../../../tmux/types';
import type { GitRepository } from '../../../workspaces/model';
import {
  LIST_PANES_COMMAND,
  LIST_WINDOWS_COMMAND,
  collectPaneCwds,
  createServersActor,
  parseSessions,
  toServerInfos,
} from '../serversActor';

// Rows are tab-joined, matching the `-F` format the actor sends.
const row = (...fields: string[]) => fields.join('\t');

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timeout waiting for serversActor');
}

function spawnServersActor(adapter: TmuxAdapter, repositories: GitRepository[] = []) {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const serversActor = createServersActor(adapter);
  const parent = createMachine({
    types: {} as {
      context: { sidebarOpen: boolean; repositories: GitRepository[] };
      events: { type: string; [key: string]: unknown };
    },
    context: { sidebarOpen: false, repositories },
    invoke: {
      id: 'servers',
      src: 'serversActor',
      input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
    },
    on: {
      '*': {
        actions: ({ event }) => {
          events.push(event as { type: string; [key: string]: unknown });
        },
      },
    },
  }).provide({ actors: { serversActor }, actions: {} } as never);
  const actor = createActor(parent);
  actor.start();
  const child = actor.getSnapshot().children.servers as AnyActorRef;
  return { actor, child, events };
}

describe('parseSessions', () => {
  it('groups windows and panes under their sessions, index-ordered', () => {
    const windows = [
      row('work', '@1', '1', 'editor', 'tab'),
      row('work', '@0', '0', 'shell', 'tab'),
      row('logs', '@5', '0', 'tail', 'tab'),
    ].join('\n');
    const panes = [
      row('work', '@0', '%0', 'bash', '/code/app', '1'),
      row('work', '@1', '%1', 'nvim', '/code/app/src', '1'),
      row('logs', '@5', '%9', 'less', '/var/log', '0'),
    ].join('\n');

    const sessions = parseSessions(windows, panes);
    // Sessions are name-sorted: logs, work.
    expect(sessions.map((s) => s.sessionName)).toEqual(['logs', 'work']);
    const work = sessions.find((s) => s.sessionName === 'work');
    expect(work?.windows.map((w) => w.index)).toEqual([0, 1]); // index-ordered
    expect(work?.panes.map((p) => p.id)).toEqual(['%0', '%1']);
    expect(work?.panes.find((p) => p.id === '%1')?.command).toBe('nvim');
    expect(work?.panes.find((p) => p.id === '%1')?.cwd).toBe('/code/app/src');
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
      row('main', '@0', '%0', 'zsh', '/home/me', '1'),
      row('main', '@1', '%1', 'fzf', '/tmp', '1'), // pane in a hidden window → dropped
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
      [
        row('s', '@0', '%0', 'bash', '/repo', '0'),
        row('s', '@0', '%1', 'top', '/repo/src', '1'),
      ].join('\n'),
    );
    expect(session.panes.find((p) => p.id === '%1')?.active).toBe(true);
    expect(session.panes.find((p) => p.id === '%0')?.active).toBe(false);
  });

  it('requests pane cwd as part of the existing tmux poll', () => {
    expect(LIST_PANES_COMMAND).toContain('#{pane_current_path}');
  });
});

describe('collectPaneCwds', () => {
  it('sorts and de-duplicates only observed non-empty pane paths', () => {
    const sessions = parseSessions(
      [row('s', '@0', '0', 'one', 'tab'), row('s', '@1', '1', 'two', 'tab')].join('\n'),
      [
        row('s', '@0', '%0', 'bash', '/repo/z', '1'),
        row('s', '@0', '%1', 'bash', '', '0'),
        row('s', '@1', '%2', 'bash', '/repo/a', '1'),
        row('s', '@1', '%3', 'bash', '/repo/z', '0'),
      ].join('\n'),
    );

    expect(collectPaneCwds(sessions)).toEqual(['/repo/a', '/repo/z']);
    expect(collectPaneCwds(parseSessions('', ''))).toEqual([]);
  });
});

describe('createServersActor worktree discovery', () => {
  it('discovers from de-duplicated observed cwd paths', async () => {
    const queryReadonly = vi.fn(async (command: string) => {
      if (command === LIST_WINDOWS_COMMAND) {
        return row('s', '@0', '0', 'shell', 'tab');
      }
      return [
        row('s', '@0', '%0', 'bash', '/repo', '1'),
        row('s', '@0', '%1', 'bash', '/repo', '0'),
      ].join('\n');
    });
    const repositories = [
      {
        id: '/repo/.git',
        name: 'repo',
        root: '/repo',
        worktrees: [],
      },
    ];
    const invoke = vi.fn(async () => repositories);
    const adapter = {
      enumeratesSessions: true,
      queryReadonly,
      invoke,
    } as unknown as TmuxAdapter;
    const { actor, child, events } = spawnServersActor(adapter);

    child.send({ type: 'REFRESH_SESSIONS' });
    await waitFor(() => events.some((event) => event.type === 'GIT_REPOSITORIES_UPDATED'));

    expect(invoke).toHaveBeenCalledWith('list_git_worktrees', { paths: ['/repo'] });
    expect(events.find((event) => event.type === 'GIT_REPOSITORIES_UPDATED')?.repositories).toEqual(
      repositories,
    );

    const sessionUpdates = events.filter((event) => event.type === 'SESSIONS_UPDATED').length;
    child.send({ type: 'REFRESH_SESSIONS' });
    await waitFor(
      () => events.filter((event) => event.type === 'SESSIONS_UPDATED').length > sessionUpdates,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it('does not invoke discovery when tmux reports no cwd', async () => {
    const queryReadonly = vi.fn(async (command: string) =>
      command === LIST_WINDOWS_COMMAND
        ? row('s', '@0', '0', 'shell', 'tab')
        : row('s', '@0', '%0', 'bash', '', '1'),
    );
    const invoke = vi.fn();
    const adapter = {
      enumeratesSessions: true,
      queryReadonly,
      invoke,
    } as unknown as TmuxAdapter;
    const { actor, child, events } = spawnServersActor(adapter);

    child.send({ type: 'REFRESH_SESSIONS' });
    await waitFor(() => events.some((event) => event.type === 'SESSIONS_UPDATED'));
    await Promise.resolve();

    expect(invoke).not.toHaveBeenCalled();
    actor.stop();
  });

  it('retains prior repository context when discovery fails', async () => {
    const previousRepositories: GitRepository[] = [
      {
        id: '/old/.git',
        name: 'old',
        root: '/old',
        worktrees: [],
      },
    ];
    const queryReadonly = vi.fn(async (command: string) =>
      command === LIST_WINDOWS_COMMAND
        ? row('s', '@0', '0', 'shell', 'tab')
        : row('s', '@0', '%0', 'bash', '/repo', '1'),
    );
    const invoke = vi.fn(async () => {
      throw new Error('git unavailable');
    });
    const adapter = {
      enumeratesSessions: true,
      queryReadonly,
      invoke,
    } as unknown as TmuxAdapter;
    const { actor, child, events } = spawnServersActor(adapter, previousRepositories);

    child.send({ type: 'REFRESH_SESSIONS' });
    await waitFor(() => invoke.mock.calls.length === 1);
    await waitFor(() => events.some((event) => event.type === 'SESSIONS_UPDATED'));
    const sessionUpdates = events.filter((event) => event.type === 'SESSIONS_UPDATED').length;
    child.send({ type: 'REFRESH_SESSIONS' });
    await waitFor(
      () => events.filter((event) => event.type === 'SESSIONS_UPDATED').length > sessionUpdates,
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'GIT_REPOSITORIES_UPDATED')).toBe(false);
    actor.stop();
  });

  it('serializes polls and coalesces triggers queued behind an in-flight poll', async () => {
    const resolvers: Array<(output: string) => void> = [];
    const queryReadonly = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const invoke = vi.fn();
    const adapter = {
      enumeratesSessions: true,
      queryReadonly,
      invoke,
    } as unknown as TmuxAdapter;
    const { actor, child, events } = spawnServersActor(adapter);

    child.send({ type: 'REFRESH_SESSIONS' });
    await waitFor(() => queryReadonly.mock.calls.length === 2);
    child.send({ type: 'REFRESH_SESSIONS' });
    child.send({ type: 'REFRESH_SESSIONS' });
    expect(queryReadonly).toHaveBeenCalledTimes(2);

    resolvers[0](row('old', '@0', '0', 'shell', 'tab'));
    resolvers[1](row('old', '@0', '%0', 'bash', '', '1'));
    await waitFor(() => queryReadonly.mock.calls.length === 4);

    resolvers[2](row('new', '@1', '0', 'shell', 'tab'));
    resolvers[3](row('new', '@1', '%1', 'bash', '', '1'));
    await waitFor(() => events.filter((event) => event.type === 'SESSIONS_UPDATED').length === 2);

    expect(queryReadonly).toHaveBeenCalledTimes(4);
    const updates = events.filter((event) => event.type === 'SESSIONS_UPDATED');
    expect(
      (updates[updates.length - 1].sessions as Array<{ sessionName: string }>)[0].sessionName,
    ).toBe('new');
    expect(invoke).not.toHaveBeenCalled();
    actor.stop();
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
