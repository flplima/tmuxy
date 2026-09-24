/**
 * Window — the desktop app's OS windows and their styles.
 *
 * The macOS build has this in its native menu bar (`tmuxy-tauri-app/src/gui.rs`
 * builds the same items); this is the copy the other desktop platforms get,
 * where the hamburger menu *is* the app menu. A browser tab has no OS windows to
 * manage, so `AppMenu` renders none of it there.
 *
 * Both lists are read when the submenu opens rather than held in the machine:
 * windows come and go from the native menu and from other windows, and the style
 * of a window is the OS's answer, not the app's.
 */

import { useState } from 'react';
import { MenuItem, SubMenu, MenuDivider } from '@szhsin/react-menu';
import {
  focusGuiWindow,
  getWindowStyle,
  listGuiWindows,
  newGuiWindow,
  setWindowStyle,
  WINDOW_STYLES,
  type GuiWindowInfo,
  type WindowStyleSlug,
} from '../../utils/guiWindows';

/** `cmd` on a Mac, `ctrl+shift` everywhere else — the shortcuts in `keyboardActor`. */
function shortcut(key: string): string {
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  return isMac ? `cmd+${key}` : `ctrl+shift+${key}`;
}

export function WindowMenu() {
  const [windows, setWindows] = useState<GuiWindowInfo[]>([]);
  const [style, setStyle] = useState<WindowStyleSlug>('normal');

  const refresh = () => {
    void listGuiWindows().then(setWindows);
    void getWindowStyle().then(setStyle);
  };

  return (
    <SubMenu
      label="Window"
      onMenuChange={(e) => {
        if (e.open) refresh();
      }}
    >
      <MenuItem onClick={newGuiWindow}>
        New Window
        <span className="menu-keybinding">{shortcut('n')}</span>
      </MenuItem>

      <MenuDivider />
      <SubMenu label="Window Style">
        {WINDOW_STYLES.map((s) => (
          <MenuItem
            key={s.slug}
            onClick={() => {
              setWindowStyle(s.slug);
              setStyle(s.slug);
            }}
          >
            {style === s.slug ? '● ' : '○ '}
            {s.label}
          </MenuItem>
        ))}
      </SubMenu>

      {windows.length > 0 && <MenuDivider />}
      {windows.map((w) => (
        <MenuItem key={w.index} onClick={() => focusGuiWindow(w.index)}>
          {w.focused ? '✓ ' : '  '}
          {w.title}
          <span className="menu-keybinding">{shortcut(String(w.index))}</span>
        </MenuItem>
      ))}
    </SubMenu>
  );
}
