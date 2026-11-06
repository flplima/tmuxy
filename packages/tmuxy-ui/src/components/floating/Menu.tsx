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
  type?: 'checkbox' | 'radio';
  checked?: boolean;
  /** For a radio item: which value of its group this one is. */
  value?: string;
  /** The icon in the item's leading column; a checkbox or radio shows its check there. */
  icon?: MenuIconName;
}

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
      onPointerEnter={(e) => {
        panel?.setOpenId(null);
        if (!disabled) e.currentTarget.focus({ preventScroll: true });
      }}
      {...rest}
    >
      <span className="menu-item-lead" aria-hidden="true">
        {type ? isChecked && <MenuIcon name="check" /> : icon && <MenuIcon name={icon} />}
      </span>
      {children}
    </div>
  );
}

export function MenuDivider() {
  return <div className="floating-menu-divider" role="separator" />;
}

export function MenuHeader({ children }: { children: ReactNode }) {
  return (
    <div className="floating-menu-header" role="presentation">
      {children}
    </div>
  );
}

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

export function SubMenu({ label, children, disabled = false, onMenuChange }: SubMenuProps) {
  const reactId = useId();
  const columnId = `floating-submenu-${reactId}`;
  const tree = useContext(MenuTreeContext);
  const panel = useContext(PanelContext);
  const triggerRef = useRef<HTMLDivElement>(null);
  const open = panel?.openId === reactId;

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
        // Opens, never toggles: pointerenter has already opened it by the time the
        // click lands, and a toggle would close it again.
        onClick={() => !disabled && panel?.setOpenId(reactId)}
        onPointerEnter={(e) => {
          if (disabled) return;
          e.currentTarget.focus({ preventScroll: true });
          panel?.setOpenId(reactId);
        }}
      >
        <span className="menu-item-lead" aria-hidden="true" />
        {label}
        {/* Not CSS `content`: some accessible-name computations read it, and the
            arrow is decoration. */}
        <span className="floating-menu-arrow" aria-hidden="true">
          {'\u25B6'}
        </span>
      </div>
      <MenuPanel
        id={`${tree?.rootId ?? 'menu'}:${reactId}`}
        domId={columnId}
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
