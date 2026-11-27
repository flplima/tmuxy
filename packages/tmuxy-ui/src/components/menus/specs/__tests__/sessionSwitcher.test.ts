import { describe, it, expect } from 'vitest';
import { createInitialContext } from '../../../../machines/app/context';
import type { AppMachineContext } from '../../../../machines/types/context';
import { sessionSwitcherSpec } from '../sessionSwitcher';
import { itemIds, type MenuEnv } from '../../../../domain/menus/spec';
import type { AppMenuNode as MenuNode, AppMenuSpec as MenuSpec } from '../actions';

const WEB: MenuEnv = { isDemo: false, isTauri: false, isMac: false };
const MAC: MenuEnv = { ...WEB, isTauri: true, isMac: true };

const ctx = (overrides: Partial<AppMachineContext> = {}): AppMachineContext => ({
  ...createInitialContext(),
  ...overrides,
});

const find = (spec: MenuSpec, id: string): MenuNode | undefined =>
  spec.find((node) => 'id' in node && node.id === id);

describe('the session switcher', () => {
  it('lists sessions with the current one marked, restorable ones, servers on the desktop', () => {
    const c = ctx({
      sessionName: 'main',
      sessions: [{ sessionName: 'main' }, { sessionName: 'work' }] as AppMachineContext['sessions'],
      restorableSessions: [{ name: 'old' }] as AppMachineContext['restorableSessions'],
      servers: [
        { id: 'localhost', label: 'localhost' },
        { id: 'box', label: 'box' },
      ] as AppMachineContext['servers'],
      currentServerId: 'localhost',
    });
    const web = sessionSwitcherSpec(c, WEB);
    expect(itemIds(web)).toEqual(['session:main', 'session:work', 'restore:old']);
    expect(find(web, 'session:main')).toMatchObject({
      label: '● main',
      data: { 'session-name': 'main', current: 'true' },
    });

    expect(itemIds(sessionSwitcherSpec(c, MAC))).toEqual([
      'session:main',
      'session:work',
      'restore:old',
      'server:localhost',
      'server:box',
      'session-connect',
    ]);
  });

  it('a filter keeps the sessions and servers whose names contain it, ignoring case, and the connect item', () => {
    const c = ctx({
      sessionName: 'main',
      sessions: ['main', 'Work-API', 'work-web', 'notes'].map((sessionName) => ({
        sessionName,
      })) as AppMachineContext['sessions'],
      restorableSessions: [
        { name: 'old-work' },
        { name: 'scratch' },
      ] as AppMachineContext['restorableSessions'],
      servers: [
        { id: 'localhost', label: 'localhost' },
        { id: 'box', label: 'workbox' },
      ] as AppMachineContext['servers'],
      currentServerId: 'localhost',
    });
    expect(itemIds(sessionSwitcherSpec(c, MAC, ' WORK '))).toEqual([
      'session:Work-API',
      'session:work-web',
      'restore:old-work',
      'server:box',
      'session-connect',
    ]);
    const none = sessionSwitcherSpec(c, MAC, 'zzz');
    expect(itemIds(none)).toEqual(['session-connect']);
    expect(none.filter((node) => node.kind === 'header')).toEqual([]);
    expect(itemIds(sessionSwitcherSpec(c, WEB, ''))).toEqual(itemIds(sessionSwitcherSpec(c, WEB)));
  });

  it('the detached overlay offers a new session first, by the typed name when no session has it', () => {
    const c = ctx({
      sessionName: 'main',
      sessions: [{ sessionName: 'main' }, { sessionName: 'work' }] as AppMachineContext['sessions'],
      restorableSessions: [{ name: 'old' }] as AppMachineContext['restorableSessions'],
    });
    const overlay = (query = '', context = c) =>
      sessionSwitcherSpec(context, WEB, query, { withNewSession: true });
    expect(itemIds(overlay())).toEqual([
      'session-new',
      'session:main',
      'session:work',
      'restore:old',
    ]);
    expect(find(overlay(), 'session-new')).toMatchObject({
      label: 'New session',
      action: { kind: 'event', event: { type: 'NEW_SESSION' } },
    });
    expect(find(overlay('scratch pad'), 'session-new')).toMatchObject({
      label: 'New session “scratch-pad”',
      action: { kind: 'event', event: { type: 'NEW_SESSION', name: 'scratch-pad' } },
    });
    // A name a session or a snapshot already has is not offered as a new one.
    for (const taken of ['work', 'old']) {
      expect(find(overlay(taken), 'session-new')).toMatchObject({ label: 'New session' });
    }
    // The status line's switcher has no such item.
    expect(itemIds(sessionSwitcherSpec(c, WEB))).not.toContain('session-new');
  });

  it('after the session ended the switcher drops it, and after a detach it keeps it', () => {
    const polled = { sessions: [{ sessionName: 'main' }] as AppMachineContext['sessions'] };
    const overlay = (context: Partial<AppMachineContext>) =>
      itemIds(
        sessionSwitcherSpec(ctx({ sessionName: 'main', ...context }), WEB, '', {
          withNewSession: true,
        }),
      );
    // The last poll, and the attached name alone when no poll has answered.
    expect(overlay({ ...polled, sessionEnded: true })).toEqual(['session-new']);
    expect(overlay({ sessionEnded: true })).toEqual(['session-new']);
    expect(overlay({ ...polled, sessionEnded: false })).toEqual(['session-new', 'session:main']);
    expect(overlay({ sessionEnded: false })).toEqual(['session-new', 'session:main']);
    // Its name is free again.
    expect(
      find(
        sessionSwitcherSpec(ctx({ sessionName: 'main', sessionEnded: true }), WEB, 'main', {
          withNewSession: true,
        }),
        'session-new',
      ),
    ).toMatchObject({ label: 'New session “main”' });
  });
});
