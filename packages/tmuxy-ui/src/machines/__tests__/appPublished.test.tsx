/**
 * `window.app` is what a test waits on before it types: "the page is up, keys
 * go somewhere". It was published while the provider rendered, before the
 * machine started its keyboard actor, so a key typed in between had no
 * listener at all: neither held for the session nor reported as not sent.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppProvider } from '../AppContext';
import { fakeTransport } from '../../test/transport';
import type { AppMachineActor } from '../app/appMachine';

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  delete (window as { app?: unknown }).app;
});

describe('the app published for tests', () => {
  it('already holds a key typed the moment it appears', async () => {
    let heldWhenPublished: number | null = null;
    let published: unknown;
    Object.defineProperty(window, 'app', {
      configurable: true,
      get: () => published,
      set: (app: AppMachineActor) => {
        published = app;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
        heldWhenPublished = app.getSnapshot().context.heldCommands.length;
      },
    });
    // jsdom has no font loading; the size actor waits on it.
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise(() => {}) },
    });
    // A connection that never lands: the page stays attaching.
    const transport = fakeTransport({ connect: () => new Promise<void>(() => {}) });

    root = createRoot(document.createElement('div'));
    await act(async () => {
      root?.render(<AppProvider transport={transport.layer}>{null}</AppProvider>);
    });

    expect(published).toBeDefined();
    expect(heldWhenPublished).toBe(1);
  });
});
