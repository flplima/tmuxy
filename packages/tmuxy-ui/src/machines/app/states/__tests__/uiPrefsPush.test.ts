import { describe, it, expect, vi, beforeEach } from 'vitest';

const push = vi.hoisted(() => ({
  enablePush: vi.fn(async () => 'on' as const),
  disablePush: vi.fn(async () => 'off' as const),
  readPushState: vi.fn(async () => 'off' as const),
  onNotificationFocus: vi.fn(),
  pushSupported: () => true,
  registerPushWorker: () => {},
}));
vi.mock('../../../../infra/pushNotifications', () => push);

import { uiPrefsState } from '../uiPrefs';
import { uiPrefsActions } from '../../actions/uiPrefs';
import { mountState, sendAndGetContext } from './testHarness';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('uiPrefs: push notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  // The switch: off asks the browser (inside the tap) and lands on what it
  // answered; on turns this device off; tmuxy.conf's off leaves it alone.
  it('TOGGLE_PUSH turns this device on or off, unless tmuxy.conf says no', async () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, {}, { pushState: 'off' });
    expect(sendAndGetContext(actor, { type: 'TOGGLE_PUSH' }).pushState).toBe('working');
    expect(push.enablePush).toHaveBeenCalledTimes(1);
    await settle();
    expect(actor.getSnapshot().context.pushState).toBe('on');

    sendAndGetContext(actor, { type: 'TOGGLE_PUSH' });
    expect(push.disablePush).toHaveBeenCalledTimes(1);
    await settle();
    expect(actor.getSnapshot().context.pushState).toBe('off');

    const blocked = mountState(
      uiPrefsState,
      uiPrefsActions,
      {},
      {
        pushState: 'off',
        notifyAllowed: false,
      },
    );
    expect(sendAndGetContext(blocked, { type: 'TOGGLE_PUSH' }).pushState).toBe('off');
    expect(push.enablePush).toHaveBeenCalledTimes(1);
  });

  // The backend's first answer says whether tmuxy.conf allows them, and is
  // when this device reads where its own notifications stand.
  it('the first theme settings read the device and carry @tmuxy-notify', async () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, {}, { pushState: 'unknown' });
    const ctx = sendAndGetContext(actor, {
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: {
        opacity: 1,
        activePaneOpacity: 1,
        inactivePaneOpacity: 1,
        activeTextOpacity: 1,
        inactiveTextOpacity: 1,
        blur: false,
        animations: true,
        notify: false,
      },
    });
    expect(ctx.notifyAllowed).toBe(false);
    expect(push.readPushState).toHaveBeenCalledTimes(1);
    expect(push.onNotificationFocus).toHaveBeenCalledTimes(1);
    await settle();
    expect(actor.getSnapshot().context.pushState).toBe('off');
  });
});
