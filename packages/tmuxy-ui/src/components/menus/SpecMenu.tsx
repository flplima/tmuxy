/**
 * The in-app renderer for a menu spec (`domain/menus/spec.ts`): the floating
 * menu every surface draws on the web, in the demo and under Storybook, and
 * the fallback on the desktop when a native popup is not to be had.
 *
 * `useMenuDispatch` is the one place an item's action becomes something
 * happening: an action id goes through `executeMenuAction`, an event to the
 * machine, and a `local` id back to the surface that owns the menu.
 */

import { useCallback } from 'react';
import { MenuItem, MenuDivider, MenuHeader, MenuRadioGroup, SubMenu } from '../floating/Menu';
import { useAppSend } from '../../machines/AppContext';
import type { MenuAction, MenuNode, MenuSpec } from '../../domain/menus/spec';
import { executeMenuAction } from './menuActions';
import { CopyIcon, SendKeysIcon } from './MenuIcons';
import type { PaneId } from '../../domain/ids';

export type MenuDispatch = (action: MenuAction) => void;

export interface MenuDispatchOptions {
  /** The pane a group-aware Close Pane acts on (see `activeCloseTarget`). */
  closeTarget?: PaneId;
  /** Runs before an action id is dispatched — a context menu focuses its pane first. */
  before?: (actionId: string) => void;
  /** The surface's own verbs: dialogs, native calls, anything not an event. */
  onLocal?: (id: string) => void;
}

export function useMenuDispatch(options: MenuDispatchOptions = {}): MenuDispatch {
  const send = useAppSend();
  const { closeTarget, before, onLocal } = options;
  return useCallback<MenuDispatch>(
    (action) => {
      switch (action.kind) {
        case 'action':
          before?.(action.id);
          executeMenuAction(send, action.id, closeTarget);
          return;
        case 'event':
          send(action.event);
          return;
        case 'local':
          onLocal?.(action.id);
          return;
      }
    },
    [send, closeTarget, before, onLocal],
  );
}

const ICONS = { copy: CopyIcon, 'send-keys': SendKeysIcon } as const;

function dataAttributes(data?: Record<string, string>): Record<string, string> {
  if (!data) return {};
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v]));
}

/** The spec as floating-menu elements. */
export function renderSpec(spec: MenuSpec, dispatch: MenuDispatch): React.ReactNode[] {
  return spec.map((node, index) => renderNode(node, index, dispatch));
}

function renderNode(node: MenuNode, index: number, dispatch: MenuDispatch): React.ReactNode {
  switch (node.kind) {
    case 'separator':
      return <MenuDivider key={`sep-${index}`} />;
    case 'header':
      return <MenuHeader key={`header-${index}`}>{node.label}</MenuHeader>;
    // The platform draws these itself; the in-app menu has no counterpart.
    case 'predefined':
      return null;
    case 'item': {
      const Icon = node.icon ? ICONS[node.icon] : null;
      return (
        <MenuItem
          key={node.id}
          disabled={node.disabled}
          className={node.className}
          data-testid={node.testId}
          {...dataAttributes(node.data)}
          onClick={() => dispatch(node.action)}
        >
          {Icon && <Icon />}
          {node.label}
          {node.external && <span className="menu-external">{'↗'}</span>}
          {node.keyHint && <span className="menu-keybinding">{node.keyHint}</span>}
        </MenuItem>
      );
    }
    case 'checkbox':
      return (
        <MenuItem
          key={node.id}
          type="checkbox"
          checked={node.checked}
          disabled={node.disabled}
          className={node.className}
          data-testid={node.testId}
          {...dataAttributes(node.data)}
          onClick={() => dispatch(node.action)}
        >
          {node.label}
          {node.keyHint && <span className="menu-keybinding">{node.keyHint}</span>}
        </MenuItem>
      );
    case 'radio-group':
      return (
        <MenuRadioGroup
          key={node.id}
          value={node.value}
          onRadioChange={({ value }) => {
            const picked = node.options.find((o) => o.value === value);
            if (picked) dispatch(picked.action);
          }}
        >
          {node.options.map((option) => (
            <MenuItem
              key={option.value}
              type="radio"
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </MenuItem>
          ))}
        </MenuRadioGroup>
      );
    case 'submenu':
      return (
        <SubMenu
          key={node.id}
          label={node.label}
          disabled={node.disabled}
          onMenuChange={node.onOpen ? (e) => e.open && dispatch(node.onOpen!) : undefined}
        >
          {renderSpec(node.children, dispatch)}
        </SubMenu>
      );
  }
}
