/**
 * The in-app renderer for a menu spec (`domain/menus/spec.ts`): the floating
 * menu every surface draws on the web, in the demo and under Storybook, and
 * the fallback on the desktop when a native popup is not to be had.
 *
 * `useMenuDispatch` is the one place an item's action becomes something
 * happening: an op goes to the store, a command through `MENU_COMMANDS`, an
 * event to the machine, and a `local` verb back to the surface that owns the
 * menu.
 */

import { useCallback } from 'react';
import { MenuItem, MenuDivider, MenuHeader, MenuRadioGroup, SubMenu } from '../floating/Menu';
import { useAppSend } from '../../machines/appHooks';
import type { MenuDispatch } from '../../domain/menus/spec';
import {
  executeMenuCommand,
  type AppMenuAction,
  type AppMenuNode,
  type AppMenuSpec,
  type MenuCommandId,
  type MenuLocal,
} from './specs/actions';
import type { PaneId } from '../../domain/ids';

export type AppMenuDispatch = MenuDispatch<AppMenuAction>;

export interface MenuDispatchOptions {
  /** The pane a group-aware Close Pane acts on (see `activeCloseTarget`). */
  closeTarget?: PaneId;
  /**
   * Runs before an op or a command is dispatched — a context menu focuses
   * its pane first. Given the command, or null for an op.
   */
  before?: (command: MenuCommandId | null) => void;
  /** The surface's own verbs: dialogs, native calls, anything not an event. */
  onLocal?: (local: MenuLocal) => void;
}

export function useMenuDispatch(options: MenuDispatchOptions = {}): AppMenuDispatch {
  const send = useAppSend();
  const { closeTarget, before, onLocal } = options;
  return useCallback<AppMenuDispatch>(
    (action) => {
      switch (action.kind) {
        case 'op':
          before?.(null);
          send({ type: 'DISPATCH_OP', op: action.op });
          return;
        case 'command':
          before?.(action.id);
          executeMenuCommand(send, action.id, closeTarget);
          return;
        case 'event':
          send(action.event);
          return;
        case 'local':
          onLocal?.(action.local);
          return;
      }
    },
    [send, closeTarget, before, onLocal],
  );
}

/** A spec item's `data` as the `data-*` attributes its element carries. */
export function dataAttributes(data?: Record<string, string>): Record<string, string> {
  if (!data) return {};
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v]));
}

/** The spec as floating-menu elements. */
export function renderSpec(spec: AppMenuSpec, dispatch: AppMenuDispatch): React.ReactNode[] {
  return spec.map((node, index) => renderNode(node, index, dispatch));
}

function renderNode(node: AppMenuNode, index: number, dispatch: AppMenuDispatch): React.ReactNode {
  switch (node.kind) {
    case 'separator':
      return <MenuDivider key={`sep-${index}`} />;
    case 'header':
      return <MenuHeader key={`header-${index}`}>{node.label}</MenuHeader>;
    // The platform draws these itself; the in-app menu has no counterpart.
    case 'predefined':
      return null;
    case 'item':
      return (
        <MenuItem
          key={node.id}
          disabled={node.disabled}
          icon={node.icon}
          className={node.className}
          data-testid={node.testId}
          {...dataAttributes(node.data)}
          onClick={() => dispatch(node.action)}
        >
          {node.label}
          {node.keyHint && <span className="menu-keybinding">{node.keyHint}</span>}
        </MenuItem>
      );
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
