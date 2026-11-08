/**
 * Window: the desktop app's OS windows and their styles. The surface fetches
 * both when the submenu opens: other windows open and close windows, and the
 * style is the OS's answer.
 */

import {
  WINDOW_STYLES,
  type GuiWindowInfo,
  type WindowStyleSlug,
} from '../../../domain/guiWindows';
import { separator, tidy, type MenuEnv } from '../../../domain/menus/spec';
import { local, type AppMenuNode } from './actions';

export interface WindowMenuState {
  windows: ReadonlyArray<GuiWindowInfo>;
  style: WindowStyleSlug;
}

export function windowMenuSpec(env: MenuEnv, state: WindowMenuState): AppMenuNode {
  // The keys the window shortcuts listen for (`windowShortcut`): bare Cmd on a
  // Mac, Ctrl+Shift elsewhere, written for the in-app menu and the native one.
  const shortcut = (key: string) =>
    env.isMac
      ? { keyHint: `cmd+${key}`, accelerator: `Cmd+${key.toUpperCase()}` }
      : { keyHint: `ctrl+shift+${key}`, accelerator: `Ctrl+Shift+${key.toUpperCase()}` };
  return {
    kind: 'submenu',
    id: 'menu-window',
    label: 'Window',
    onOpen: local({ verb: 'window-refresh' }),
    children: tidy([
      {
        kind: 'item',
        id: 'window-new',
        label: 'New Window',
        icon: 'new',
        ...shortcut('n'),
        action: local({ verb: 'window-new' }),
      },
      separator,
      {
        kind: 'submenu',
        id: 'menu-window-style',
        label: 'Window Style',
        children: WINDOW_STYLES.map((s) => ({
          kind: 'checkbox',
          id: `window-style-${s.slug}`,
          label: s.label,
          checked: state.style === s.slug,
          action: local({ verb: 'window-style', slug: s.slug }),
        })),
      },
      separator,
      { kind: 'predefined', which: 'minimize' },
      { kind: 'predefined', which: 'maximize' },
      separator,
      // Not the predefined item: its accelerator is Cmd+W, which is Close
      // Tab's. Closing the OS window takes the shift.
      {
        kind: 'item',
        id: 'window-close',
        label: 'Close Window',
        icon: 'close',
        accelerator: 'CmdOrCtrl+Shift+W',
        action: local({ verb: 'window-close' }),
      },
      state.windows.length > 0 && separator,
      ...state.windows.map(
        (w): AppMenuNode => ({
          kind: 'checkbox',
          id: `window-focus-${w.index}`,
          label: w.title,
          checked: w.focused,
          ...shortcut(String(w.index)),
          action: local({ verb: 'window-focus', index: w.index }),
        }),
      ),
    ]),
  };
}
