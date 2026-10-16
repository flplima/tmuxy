/**
 * Window — the desktop app's OS windows and their styles. Both lists are
 * read when the submenu opens rather than held in the machine: windows come
 * and go from other windows, and the style of a window is the OS's answer,
 * not the app's — so the surface fetches them and hands them here.
 */

import { WINDOW_STYLES, type GuiWindowInfo, type WindowStyleSlug } from '../../utils/guiWindows';
import { local, separator, tidy, type MenuEnv, type MenuNode } from './spec';

export interface WindowMenuState {
  windows: ReadonlyArray<GuiWindowInfo>;
  style: WindowStyleSlug;
}

export function windowMenuSpec(env: MenuEnv, state: WindowMenuState): MenuNode {
  const shortcut = (key: string) => (env.isMac ? `cmd+${key}` : `ctrl+shift+${key}`);
  return {
    kind: 'submenu',
    id: 'menu-window',
    label: 'Window',
    onOpen: local('window-refresh'),
    children: tidy([
      {
        kind: 'item',
        id: 'window-new',
        label: 'New Window',
        keyHint: shortcut('n'),
        accelerator: 'CmdOrCtrl+N',
        action: local('window-new'),
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
          action: local(`window-style:${s.slug}`),
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
        accelerator: 'CmdOrCtrl+Shift+W',
        action: local('window-close'),
      },
      state.windows.length > 0 && separator,
      ...state.windows.map(
        (w): MenuNode => ({
          kind: 'checkbox',
          id: `window-focus-${w.index}`,
          label: w.title,
          checked: w.focused,
          keyHint: shortcut(String(w.index)),
          accelerator: `CmdOrCtrl+${w.index}`,
          action: local(`window-focus:${w.index}`),
        }),
      ),
    ]),
  };
}
