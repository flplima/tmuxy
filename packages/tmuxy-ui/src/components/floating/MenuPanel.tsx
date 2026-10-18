/**
 * MenuPanel & MenuSurface — the floating surface column and keyboard/dismiss
 * handling shared by FloatingMenu and SubMenu.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector } from '../../machines/AppContext';
import { selectAnimationsAllowed } from '../../machines/selectors/ui';
import {
  SURFACE_EXIT_MS,
  surfacePortalTarget,
  useFloatingSurface,
  type SurfaceAnchor,
  type SurfacePlacement,
} from './useFloatingSurface';

/**
 * The open state handed to `useFloatingSurface`, as a module constant.
 *
 * The hook keys its lifecycle on `JSON.stringify(content)` to survive callers
 * passing a fresh object literal every render; a menu has no content to
 * describe beyond "open", so there is one value and it never changes.
 */
const OPEN = { open: true } as const;

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

/** Every item of `panel`, in document order, skipping the disabled ones. */
function navigableItems(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter(
    (item) =>
      item.closest('[data-menu-panel]') === panel && item.getAttribute('aria-disabled') !== 'true',
  );
}

export interface MenuPanelProps {
  /** Identity in the floating-surface registry. */
  id: string;
  anchor: SurfaceAnchor;
  placement?: SurfacePlacement;
  /** False for a submenu: the layer belongs to the menu that opened it. */
  claim?: boolean;
  open: boolean;
  onClose: () => void;
  /**
   * The box this menu is REPLACING, if it is replacing one.
   *
   * Right-clicking a tab whose preview is up turns that card into this menu,
   * and a card that vanishes while a menu appears somewhere else is two events
   * where the user performed one. Given the old card's box the menu opens
   * from it — the same object, becoming something else.
   */
  morphFrom?: DOMRect | null;
  /** What a screen reader calls it. */
  label?: string;
  /** The element id a submenu's trigger points `aria-controls` at. */
  domId?: string;
  testId?: string;
  /** Clicks in here are the trigger's own, not "outside" (see below). */
  ignoreRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * One column of a menu: the surface, its items' keyboard handling, and the
 * ways it can be dismissed. Used for the menu itself and for every submenu.
 *
 * Split in two on purpose. This half owns the lifetime — the hook holds the
 * node open for its exit animation — and the half below is mounted only while
 * there is something on screen, so which submenu is unfolded is state that
 * comes and goes WITH the menu rather than state an effect has to remember to
 * clear (a menu reopened after choosing "Theme" would otherwise reopen with
 * Theme still unfolded).
 */
export function MenuPanel({
  id,
  anchor,
  placement,
  claim = true,
  open,
  onClose,
  morphFrom = null,
  label,
  domId,
  testId,
  ignoreRef,
  children,
}: MenuPanelProps) {
  const animations = useAppSelector(selectAnimationsAllowed);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const { ref, shown, leaving, reposition } = useFloatingSurface<typeof OPEN>({
    id,
    content: open ? OPEN : null,
    anchor,
    placement,
    claim,
    exitMs: SURFACE_EXIT_MS,
    animated: animations,
    onDismiss: () => closeRef.current(),
  });

  /**
   * Place the menu, and draw it from `morphFrom` if it is replacing something.
   *
   * A FLIP: the menu goes where it belongs, then is drawn where the card was
   * and animated to zero. Everything here is measured, so the morph animation
   * is CANCELLED first — a box read while a transform is playing is the box on
   * the way rather than the one being measured for, which would make each
   * recomputation drift further from the truth.
   */
  const place = useCallback(() => {
    const panel = ref.current;
    if (!panel) return;
    const morphing = panel
      .getAnimations()
      .find((a) => (a as CSSAnimation).animationName === 'floating-surface-morph');
    morphing?.cancel();
    reposition();
    if (!morphFrom || !animations) return;
    const box = panel.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    panel.style.setProperty('--morph-x', `${Math.round(morphFrom.left - box.left)}px`);
    panel.style.setProperty('--morph-y', `${Math.round(morphFrom.top - box.top)}px`);
    panel.style.setProperty('--morph-sx', String(Math.max(0.1, morphFrom.width / box.width)));
    panel.style.setProperty('--morph-sy', String(Math.max(0.1, morphFrom.height / box.height)));
    morphing?.play();
  }, [morphFrom, animations, reposition, ref]);

  /**
   * Its own size is what the placement was computed from, so a menu that
   * changes size while it is up is placed again rather than left overhanging:
   * a submenu reading the OS's windows when it opens, and — the case that
   * matters for the morph — a menu whose stylesheet arrives after its first
   * layout, which is how a dev server serves CSS. A morph computed against
   * that first, unstyled box aimed the animation at a place the menu never
   * ended up, by exactly the width the stylesheet added.
   */
  useEffect(() => {
    const panel = ref.current;
    if (!shown || !panel || typeof ResizeObserver === 'undefined') return;
    let first = true;
    const observer = new ResizeObserver(() => {
      // The observer fires once on observe; the mount effect below has already
      // placed the menu by then.
      if (first) {
        first = false;
        return;
      }
      place();
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [shown, ref, place]);

  /**
   * Place it before the browser paints it — and after the hook's own placement
   * effect, which is why this is here rather than in the surface below: React
   * runs a child's layout effects BEFORE its parent's, so a morph computed in
   * the child is computed against a box that has not been placed yet, and then
   * the parent measures a box the morph is already scaling.
   */
  useLayoutEffect(() => {
    if (shown) place();
  }, [shown, place]);

  useEffect(() => {
    if (!shown) return;
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [shown, place]);

  if (!shown) return null;

  return createPortal(
    <MenuSurface
      panelId={id}
      surfaceRef={ref}
      leaving={leaving}
      morphing={Boolean(morphFrom) && animations}
      onClose={onClose}
      label={label}
      domId={domId}
      testId={testId}
      ignoreRef={ignoreRef}
    >
      {children}
    </MenuSurface>,
    surfacePortalTarget(),
  );
}

interface MenuSurfaceProps {
  panelId: string;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  leaving: boolean;
  /** Only for the class that plays the morph; the placement is the parent's. */
  morphing: boolean;
  onClose: () => void;
  label?: string;
  domId?: string;
  testId?: string;
  ignoreRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

/** The part that exists only while the menu is on screen. */
function MenuSurface({
  panelId,
  surfaceRef,
  leaving,
  morphing,
  onClose,
  label,
  domId,
  testId,
  ignoreRef,
  children,
}: MenuSurfaceProps) {
  const parent = useContext(MenuTreeContext);
  const [openId, setOpenId] = useState<string | null>(null);

  const rootId = parent?.rootId ?? panelId;
  const closeAll = parent?.closeAll ?? onClose;
  const closeAllRef = useRef(closeAll);
  closeAllRef.current = closeAll;

  const tree = useMemo<MenuTreeContextValue>(
    () => ({ rootId, closeAll: () => closeAllRef.current() }),
    [rootId],
  );
  const panelValue = useMemo<PanelContextValue>(() => ({ openId, setOpenId }), [openId]);

  // Focus lands on the first item when the menu opens: a menu you have to
  // reach for with the mouse before the keyboard will move through it is not
  // keyboard-operable at all (WAI-ARIA's menu pattern asks for exactly this).
  useEffect(() => {
    const panel = surfaceRef.current;
    if (!panel) return;
    const first = navigableItems(panel)[0];
    (first ?? panel).focus({ preventScroll: true });
  }, [surfaceRef]);

  // Only the menu's own root watches for the press that dismisses it: a
  // submenu is inside its root's subtree as far as this is concerned, and two
  // listeners would race to close the same menu.
  useEffect(() => {
    if (parent) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(`[data-menu-root="${rootId}"]`)) return;
      // The control that opened the menu is not "outside" it. Without this the
      // press that closes the menu is also the press that reopens it: a
      // hamburger that toggles does nothing at all, and a ⋮ that always opens
      // blinks its menu shut and back. A control that says it opens a menu is
      // covered by the rule; `ignoreRef` is for an anchor that is not one.
      if (target?.closest('[aria-haspopup="menu"]')) return;
      if (ignoreRef?.current && target && ignoreRef.current.contains(target)) return;
      closeAllRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [parent, rootId, ignoreRef]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const panel = surfaceRef.current;
    if (!panel) return;
    const items = navigableItems(panel);
    const active = document.activeElement as HTMLElement | null;
    const index = active ? items.indexOf(active) : -1;
    const focus = (next: number) => {
      if (items.length === 0) return;
      items[(next + items.length) % items.length]?.focus({ preventScroll: true });
    };

    switch (event.key) {
      case 'ArrowDown':
        focus(index + 1);
        break;
      case 'ArrowUp':
        focus(index <= 0 ? items.length - 1 : index - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(items.length - 1);
        break;
      case 'Escape':
        onClose();
        break;
      case 'ArrowLeft':
        // Out of a submenu and back to the item that opened it. At the top
        // level there is nothing to the left, so the key is left alone.
        if (!parent) return;
        onClose();
        break;
      case 'ArrowRight': {
        // Into the submenu under the cursor, if this item has one. Open, it is
        // already on screen and the cursor moves into it; closed, opening it is
        // what puts the cursor there (the column focuses its first item as it
        // mounts). Without the first case, right on an open submenu left the
        // cursor on the item that opened it and the column unreachable.
        if (active?.getAttribute('aria-haspopup') !== 'menu') return;
        const controls = active.getAttribute('aria-controls');
        const column = controls ? document.getElementById(controls) : null;
        if (column) navigableItems(column)[0]?.focus({ preventScroll: true });
        else active.click();
        break;
      }
      case 'Enter':
      case ' ':
        if (index < 0) return;
        active?.click();
        break;
      default:
        return;
    }
    // Only for the keys above, and only once they have been acted on: every
    // other key is the app's (the pane behind this menu is a terminal, and the
    // window-level handler forwards to it).
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <MenuTreeContext.Provider value={tree}>
      <PanelContext.Provider value={panelValue}>
        <div
          ref={surfaceRef}
          className={`floating-surface floating-menu${leaving ? ' is-leaving' : ''}${
            morphing ? ' is-morphing' : ''
          }`}
          id={domId}
          role="menu"
          aria-label={label}
          aria-orientation="vertical"
          tabIndex={-1}
          data-menu-panel=""
          data-menu-root={rootId}
          data-testid={testId}
          onKeyDown={onKeyDown}
        >
          {children}
        </div>
      </PanelContext.Provider>
    </MenuTreeContext.Provider>
  );
}
