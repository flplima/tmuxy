/**
 * The inventory as the client reads it from `@tmuxy-plugins`: what the
 * server's `plugins::inventory` writes parses, and anything else (a name a
 * command line could not carry, a broken option) is dropped, never shown.
 */

import { describe, it, expect } from 'vitest';
import { parseInventory, pluginMenuEntries, type PluginInfo } from '../plugins';

const b64 = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes));
};

describe('parseInventory', () => {
  it('reads what the server writes, titles in any script', () => {
    const plugins = parseInventory(
      b64([
        {
          name: 'devtools',
          actions: [
            { id: 'open', title: 'Öffnen — DevTools', menu: 'pane', surface: 'popup' },
            { id: 'quiet', title: 'Quiet', surface: 'split' },
          ],
        },
      ]),
    );
    expect(plugins).toEqual([
      {
        name: 'devtools',
        actions: [
          { id: 'open', title: 'Öffnen — DevTools', menu: 'pane', surface: 'popup' },
          { id: 'quiet', title: 'Quiet', menu: null, surface: 'split' },
        ],
      },
    ]);
  });

  it('drops names a command line could not carry, and unknown menus', () => {
    const plugins = parseInventory(
      b64([
        { name: 'bad name', actions: [] },
        {
          name: 'ok',
          actions: [
            { id: '$(id)', title: 'X', menu: 'pane' },
            { id: 'fine', title: 'Fine', menu: 'toolbar' },
            { id: 'blank', title: '   ', menu: 'pane' },
          ],
        },
      ]),
    );
    expect(plugins).toEqual([
      { name: 'ok', actions: [{ id: 'fine', title: 'Fine', menu: null, surface: 'split' }] },
    ]);
  });

  it.each(['', '   ', 'not base64 !!', btoa('{"not":"an array"}'), btoa('[1,')])(
    'an unreadable option %j is no plugins',
    (raw) => {
      expect(parseInventory(raw)).toEqual([]);
    },
  );
});

describe('pluginMenuEntries', () => {
  const plugins: PluginInfo[] = [
    {
      name: 'a',
      actions: [
        { id: 'x', title: 'X', menu: 'pane', surface: 'split' },
        { id: 'y', title: 'Y', menu: 'selection', surface: 'tab' },
      ],
    },
    { name: 'b', actions: [{ id: 'z', title: 'Z', menu: 'pane', surface: 'float' }] },
  ];

  it('lists a menu’s actions in inventory order', () => {
    expect(pluginMenuEntries(plugins, 'pane').map((e) => `${e.plugin}:${e.action.id}`)).toEqual([
      'a:x',
      'b:z',
    ]);
    expect(pluginMenuEntries(plugins, 'app')).toEqual([]);
  });
});
