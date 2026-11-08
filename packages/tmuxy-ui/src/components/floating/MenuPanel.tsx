import {
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
import { useAppSelector } from '../../machines/appHooks';
import { selectAnimationsAllowed } from '../../machines/selectors/ui';
import {
  surfacePortalTarget,
  useFloatingSurface,
  type SurfaceAnchor,
  type SurfacePlacement,
} from './useFloatingSurface';
import {
  MenuTreeContextValue,
  MenuTreeContext,
  PanelContextValue,
  PanelContext,
} from './menuContexts';

const OPEN = { open: true } as const;

function navigableItems(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter(
    (item) =>
      item.closest('[data-menu-panel]') === panel && item.getAttribute('aria-disabled') !== 'true',
  );
}

export interface MenuPanelProps {
  id: string;
  anchor: SurfaceAnchor;
  placement?: SurfacePlacement;
  /** False for a submenu: the layer belongs to the menu that opened it. */
  claim?: boolean;
  open: boolean;
  onClose: () => void;
  /** The preview card this menu replaces, if any: the menu is drawn opening from its box. */
  morphFrom?: DOMRect | null;
  label?: string;
  /** The element id a submenu's trigger points `aria-controls` at. */
  domId?: string;
  testId?: string;
  /** Clicks in here are the trigger's own, not "outside". */
  ignoreRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * One column of a menu. Split in two so the half below, and with it which
 * submenu is unfolded, mounts only while the menu is on screen: a reopened menu
 * starts folded.
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
    animated: animations,
    onDismiss: () => closeRef.current(),
  });

  // The morph animation is cancelled before measuring: a box read while a
  // transform plays is the in-flight box.
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

  // Placed again when its size changes: a submenu reading the OS's windows as it
  // opens, and a dev server that serves the stylesheet after the first layout
  // (a morph computed against that unstyled box misses by the added width).
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

  // Here rather than in MenuSurface: React runs a child's layout effects before
  // its parent's, so the child would measure a box the hook has not placed yet.
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
  morphing: boolean;
  onClose: () => void;
  label?: string;
  domId?: string;
  testId?: string;
  ignoreRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

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

  // Focus the first item on open (WAI-ARIA menu pattern), in the commit that
  // draws it: a passive effect runs a task later, and a key landing in between
  // would close the column before the late focus pulls the cursor back into it.
  useLayoutEffect(() => {
    const panel = surfaceRef.current;
    if (!panel) return;
    const first = navigableItems(panel)[0];
    (first ?? panel).focus({ preventScroll: true });
  }, [surfaceRef]);

  useEffect(() => {
    if (parent) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(`[data-menu-root="${rootId}"]`)) return;
      // The control that opened the menu is not "outside" it, or the press that
      // closes the menu would reopen it. `ignoreRef` is for an anchor that does
      // not say `aria-haspopup="menu"`.
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
        if (!parent) return;
        onClose();
        break;
      case 'ArrowRight': {
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
    // Every other key is the app's: the window-level handler forwards it to the
    // terminal behind the menu.
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
