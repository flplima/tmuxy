/**
 * Web push on this device: the service worker that shows the notifications
 * (`public/sw.js`), and the subscription the server pushes to when a pane
 * comes to need the user (tmuxy-server/src/push.rs).
 *
 * A browser tab and the app installed on a phone's home screen both get
 * them, open or not. On an iPhone only the installed app can: Safari offers
 * push to a home-screen web app alone. The desktop app has no service
 * worker, so it is never offered.
 *
 * Permission can only be asked from the tap that wants it — WebKit refuses
 * it a moment later — so `enablePush` asks first, synchronously, and does
 * everything else after.
 */

import { isTauri } from './platform';

/** Where this device stands. `working` while a switch is under way. */
export type PushState = 'unsupported' | 'unknown' | 'denied' | 'off' | 'on' | 'working';

const WORKER_URL = '/sw.js';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    !isTauri() &&
    window.isSecureContext === true &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** A failed step's fallback, with the reason on the console: the menu shows only the state. */
function warned<T>(step: string, fallback: T): (error: unknown) => T {
  return (error) => {
    console.warn(`[push] ${step} failed:`, error);
    return fallback;
  };
}

export function registerPushWorker(): void {
  if (!pushSupported()) return;
  navigator.serviceWorker.register(WORKER_URL).catch(warned('worker registration', undefined));
}

async function subscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function readPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  return (await subscription()) ? 'on' : 'off';
}

/** A base64url key as the bytes `pushManager.subscribe` takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Turn notifications on for this device. Call it from the tap itself: the
 * permission is asked before anything is awaited. A subscription made with
 * another key (the server's state dir was reset) is replaced.
 */
export function enablePush(): Promise<PushState> {
  const permission = Notification.requestPermission();
  return (async (): Promise<PushState> => {
    if ((await permission) !== 'granted') {
      return Notification.permission === 'denied' ? 'denied' : 'off';
    }
    await navigator.serviceWorker.register(WORKER_URL);
    const registration = await navigator.serviceWorker.ready;
    const keyResponse = await fetch('/api/push');
    if (!keyResponse.ok) return 'off';
    const { publicKey } = (await keyResponse.json()) as { publicKey: string };
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    const created = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
    const saved = await fetch('/api/push/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(created.toJSON()),
    });
    if (!saved.ok) {
      await created.unsubscribe();
      return 'off';
    }
    return 'on';
  })().catch(warned<PushState>('enable', 'off'));
}

/** Turn notifications off for this device: the server forgets it too. */
export async function disablePush(): Promise<PushState> {
  const current = await subscription().catch(warned('reading the subscription', null));
  if (current) {
    await fetch('/api/push/subscription', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: current.endpoint }),
    }).catch(warned('telling the server', undefined));
    await current.unsubscribe().catch(warned('unsubscribing', false));
  }
  return readPushState().catch(warned<PushState>('reading the state', 'off'));
}

/**
 * A tapped notification asks the window already on its session to bring
 * its pane forward (`public/sw.js`); `focus` is how.
 */
export function onNotificationFocus(focus: (paneId: string) => void): void {
  if (!pushSupported()) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; paneId?: string | null } | null;
    if (data?.type === 'tmuxy-focus-pane' && data.paneId) focus(data.paneId);
  });
}
