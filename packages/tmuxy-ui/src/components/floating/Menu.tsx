/**
 * The menu primitive: a floating surface with items in it.
 *
 * Every menu in tmuxy — the app's hamburger, the tab and pane context menus,
 * the selection menu, the session switcher — is the same object as the tab
 * preview: a card that floats over the grid, hangs off something, has to stay
 * inside the window, and has to go away when another one opens. That was only
 * true of the preview; the menus came from a library that owned its own
 * placement, its own portal and its own (disabled) transitions, so the two
 * disagreed about all three and the registry could do no more than tell a menu
 * to close.
 *
 * So the menus are built on `useFloatingSurface` too. What is left here is what
 * makes a surface a MENU rather than a card: items, the roles a screen reader
 * reads, arrow-key navigation, submenus that open beside their item, and the
 * rule that choosing something closes the whole thing.
 *
 * The component names mirror the library's on purpose (`MenuItem`,
 * `MenuDivider`, `SubMenu`, …): the call sites are lists of items and they were
 * already written that way, so adopting this is an import change rather than a
 * rewrite of every menu in the app.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { SurfaceAnchor, SurfacePlacement } from './useFloatingSurface';
import { MenuPanel } from './MenuPanel';
import { MenuTreeContext, PanelContext } from './menuContexts';
import { MenuIcon } from '../menus/MenuIcons';
import type { MenuIconName } from '../../domain/menus/icons';
import './Menu.css';

/** What an item's `onClick` receives — the shape the call sites already read. */
export interface MenuClickEvent {
  /** For a checkbox item: what it would become. */
  checked: boolean;
  /** For a radio item: the value it stands for. */
  value?: string;
}

interface RadioContextValue {
  value: string | undefined;
  onChange: (value: string) => void;
}
const RadioContext = createContext<RadioContextValue | null>(null);

export interface FloatingMenuProps {
  /** Identity in the floating-surface registry — peers dismiss each other. */
  id: string;
  anchor: SurfaceAnchor;
  placement?: SurfacePlacement;
  /** Defaults to true: a menu that is mounted is a menu that is open. */
  open?: boolean;
  onClose: () => void;
  morphFrom?: DOMRect | null;
  label?: string;
  testId?: string;
  ignoreRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * A menu hanging off `anchor`. Opening one puts away every other floating
 * surface — a preview, another menu — because they share one layer.
 */
export function FloatingMenu({ open = true, placement, ...rest }: FloatingMenuProps) {
  return <MenuPanel open={open} placement={{ align: 'start', ...placement }} {...rest} />;
}

export interface MenuItemProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onClick' | 'type' | 'children'
> {
  children: ReactNode;
  onClick?: (event: MenuClickEvent) => void;
  disabled?: boolean;
  /** A plain item by default; the other two draw and announce their state. */
  type?: 'checkbox' | 'radio';
  checked?: boolean;
  /** For a radio item: which value of its group this one is. */
  value?: string;
  /** The icon in the item's leading column; a checkbox or radio shows its check there. */
  icon?: MenuIconName;
}

/** One line of a menu. Choosing it does its thing and closes the menu. */
export function MenuItem({
  children,
  onClick,
  disabled = false,
  type,
  checked = false,
  value,
  icon,
  className,
  ...rest
}: MenuItemProps) {
  const tree = useContext(MenuTreeContext);
  const panel = useContext(PanelContext);
  const radio = useContext(RadioContext);

  const isRadio = type === 'radio';
  const isChecked = isRadio ? radio?.value === value : checked;
  const role = type === 'checkbox' ? 'menuitemcheckbox' : isRadio ? 'menuitemradio' : 'menuitem';

  const activate = () => {
    if (disabled) return;
    if (isRadio && value !== undefined) radio?.onChange(value);
    onClick?.({ checked: !isChecked, value });
    tree?.closeAll();
  };

  return (
    <div
      role={role}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      aria-checked={type ? isChecked : undefined}
      className={`floating-menu-item${disabled ? ' is-disabled' : ''}${
        className ? ` ${className}` : ''
      }`}
      onClick={activate}
      // Moving onto a plain item folds away whatever submenu was open, the way
      // every menu does: the pointer has left that branch.
      onPointerEnter={(e) => {
        panel?.setOpenId(null);
        if (!disabled) e.currentTarget.focus({ preventScroll: true });
      }}
      {...rest}
    >
      {/* Every item has the column, so the labels line up whether or not the
          one above had an icon or a check in it. */}
      <span className="menu-item-lead" aria-hidden="true">
        {type ? isChecked && <MenuIcon name="check" /> : icon && <MenuIcon name={icon} />}
      </span>
      {children}
    </div>
  );
}

/** A line between groups of items. */
export function MenuDivider() {
  return <div className="floating-menu-divider" role="separator" />;
}

/** A label over a group of items — not itself choosable. */
export function MenuHeader({ children }: { children: ReactNode }) {
  return (
    <div className="floating-menu-header" role="presentation">
      {children}
    </div>
  );
}

/** Exactly one of the items inside is chosen; picking one clears the rest. */
export function MenuRadioGroup({
  value,
  onRadioChange,
  children,
}: {
  value?: string;
  onRadioChange: (event: { value: string }) => void;
  children: ReactNode;
}) {
  const changeRef = useRef(onRadioChange);
  changeRef.current = onRadioChange;
  const context = useMemo<RadioContextValue>(
    () => ({ value, onChange: (next: string) => changeRef.current({ value: next }) }),
    [value],
  );
  return (
    <RadioContext.Provider value={context}>
      <div role="group">{children}</div>
    </RadioContext.Provider>
  );
}

export interface SubMenuProps {
  label: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  /** Told when it opens, for a submenu whose contents are read on demand. */
  onMenuChange?: (event: { open: boolean }) => void;
}

/**
 * An item that opens a column of its own beside it.
 *
 * It does NOT claim the floating layer: a submenu belongs to the menu it hangs
 * off, and one that claimed the layer would dismiss its own parent as it
 * opened.
 */
export function SubMenu({ label, children, disabled = false, onMenuChange }: SubMenuProps) {
  const reactId = useId();
  // The column's element id, so the item can say what it opens — which is both
  // what a screen reader follows and how the keyboard finds it.
  const columnId = `floating-submenu-${reactId}`;
  const tree = useContext(MenuTreeContext);
  const panel = useContext(PanelContext);
  const triggerRef = useRef<HTMLDivElement>(null);
  const open = panel?.openId === reactId;

  // Kept in a ref: the call sites pass an inline arrow, so depending on it
  // would fire this on every render of the menu rather than on open/close.
  const changeRef = useRef(onMenuChange);
  changeRef.current = onMenuChange;
  useEffect(() => {
    changeRef.current?.({ open });
  }, [open]);

  const close = useCallback(() => {
    panel?.setOpenId(null);
    triggerRef.current?.focus({ preventScroll: true });
  }, [panel]);

  return (
    <>
      <div
        ref={triggerRef}
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? columnId : undefined}
        aria-disabled={disabled || undefined}
        className={`floating-menu-item floating-menu-item-parent${disabled ? ' is-disabled' : ''}${
          open ? ' is-open' : ''
        }`}
        // Opens, never toggles. The pointer that reaches an item has already
        // hovered it, and a click that toggled would close the submenu its own
        // hover just opened — the item would look like it did nothing.
        onClick={() => !disabled && panel?.setOpenId(reactId)}
        onPointerEnter={(e) => {
          if (disabled) return;
          e.currentTarget.focus({ preventScroll: true });
          panel?.setOpenId(reactId);
        }}
      >
        <span className="menu-item-lead" aria-hidden="true" />
        {label}
        {/* Drawn here rather than as CSS `content`, which some accessible-name
            computations read: the arrow is decoration, and an item called
            "Theme ▶" is not what a screen reader should say. */}
        <span className="floating-menu-arrow" aria-hidden="true">
          {'\u25B6'}
        </span>
      </div>
      <MenuPanel
        id={`${tree?.rootId ?? 'menu'}:${reactId}`}
        domId={columnId}
        // Named after the item it belongs to, so a screen reader announcing
        // the column says which branch of the menu it is.
        label={typeof label === 'string' ? label : undefined}
        anchor={{ kind: 'element', element: triggerRef.current }}
        placement={{ side: 'right' }}
        claim={false}
        open={open}
        onClose={close}
      >
        {children}
      </MenuPanel>
    </>
  );
}
