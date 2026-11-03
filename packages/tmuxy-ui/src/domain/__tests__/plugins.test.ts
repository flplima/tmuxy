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
          linkHosts: [],
          textLinks: false,
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
        linkHosts: [],
        textLinks: false,
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
          linkHosts: [],
          textLinks: false,
        },
      ]),
    );
    expect(plugins).toEqual([
      {
        name: 'ok',
        actions: [{ id: 'fine', title: 'Fine', menu: null, surface: 'split' }],
        linkHosts: [],
        textLinks: false,
      },
    ]);
  });

  it('keeps the link hosts a URL handler takes, and drops any that is not a host', () => {
    const [plugin] = parseInventory(
      b64([
        {
          name: 'links',
          actions: [],
          link_hosts: ['claude.ai', 'xn--80ak6aa92e.com', 'Evil Host', 'a/b', 7],
          text_links: true,
        },
      ]),
    );
    expect(plugin.linkHosts).toEqual(['claude.ai', 'xn--80ak6aa92e.com']);
    expect(plugin.textLinks).toBe(true);
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
      linkHosts: [],
      textLinks: false,
    },
    {
      name: 'b',
      actions: [{ id: 'z', title: 'Z', menu: 'pane', surface: 'float' }],
      linkHosts: [],
      textLinks: false,
    },
  ];

  it('lists a menu’s actions in inventory order', () => {
    expect(pluginMenuEntries(plugins, 'pane').map((e) => `${e.plugin}:${e.action.id}`)).toEqual([
      'a:x',
      'b:z',
    ]);
    expect(pluginMenuEntries(plugins, 'app')).toEqual([]);
  });
});
