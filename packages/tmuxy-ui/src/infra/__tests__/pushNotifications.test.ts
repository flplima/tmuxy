import { describe, it, expect } from 'vitest';
import { keyBytes, pushSupported, readPushState } from '../pushNotifications';

describe('pushNotifications', () => {
  // The server hands its VAPID key out as unpadded base64url; a subscribe
  // with the bytes decoded wrong is refused by the push service.
  it('decodes the server key from unpadded base64url', () => {
    expect([...keyBytes('BP8A_w')]).toEqual([0x04, 0xff, 0x00, 0xff]);
    expect(keyBytes('BP8A_w').buffer).toBeInstanceOf(ArrayBuffer);
  });

  // A page with no service worker or push manager (jsdom here, the desktop
  // app's webview) is never offered notifications.
  it('a page without push support reads as unsupported', async () => {
    expect(pushSupported()).toBe(false);
    expect(await readPushState()).toBe('unsupported');
  });
});
