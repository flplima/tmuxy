/**
 * The React contexts a menu tree and its panels share.
 */

import { createContext } from 'react';

export interface MenuTreeContextValue {
  /** Scopes outside-click detection: every panel of one menu shares it. */
  rootId: string;
  /** Choosing anything puts the whole menu away, submenus included. */
  closeAll: () => void;
}

export const MenuTreeContext = createContext<MenuTreeContextValue | null>(null);

export interface PanelContextValue {
  /** Which submenu of THIS panel is open, by the id its trigger owns. */
  openId: string | null;
  setOpenId: (id: string | null) => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);
