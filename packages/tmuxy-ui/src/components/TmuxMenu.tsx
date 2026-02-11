/**
 * TmuxMenu - Dropdown menu for tmux commands
 */

import { TMUX_MENU_ITEMS, type TmuxMenuItem } from '../constants/menuItems';

interface TmuxMenuProps {
  onItemClick: (item: TmuxMenuItem) => void;
}

export function TmuxMenu({ onItemClick }: TmuxMenuProps) {
  return (
    <div className="tmux-menu">
      {TMUX_MENU_ITEMS.map((item, index) => {
        if (item.divider) {
          return <div key={index} className="tmux-menu-divider" />;
        }
        return (
          <button
            key={index}
            className="tmux-menu-item"
            onClick={() => onItemClick(item)}
          >
            <span className="tmux-menu-label">{item.label}</span>
            {item.key && <span className="tmux-menu-key">⌃A {item.key}</span>}
          </button>
        );
      })}
    </div>
  );
}
