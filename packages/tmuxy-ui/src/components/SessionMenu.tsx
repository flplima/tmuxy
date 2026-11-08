/**
 * The session switcher. It lists the sessions on the socket this client is
 * attached to — the set `switch-client` can reach.
 *
 * Servers are a second section, only when there is more than one: attaching
 * to another socket is not a `switch-client` but a retarget of the backend's
 * monitor (`connect_server`, a Tauri command) — a web client's server is
 * pinned to one socket at launch. Adding a server is a form, so that item
 * opens a pane.
 *
 * Drawn in-app on every platform: a native popup cannot hold the filter box.
 */

import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector } from '../machines/appHooks';
import { selectAnimationsAllowed } from '../machines/selectors/ui';
import { surfacePortalTarget, useFloatingSurface } from './floating/useFloatingSurface';
import { useMenuDispatch } from './menus/SpecMenu';
import { SessionPicker, type SwitcherItem } from './SessionPicker';

/** The open state handed to `useFloatingSurface`: one value, so its key never changes. */
const OPEN = { open: true } as const;

interface SessionMenuProps {
  /**
   * An element rather than a point: the surface measures it to keep the
   * dropdown on screen, so the status line's switcher opens upward.
   */
  // `useRef<T>(null)` yields `RefObject<T | null>`; the dropdown reads
  // `.current` only once it is open, by which point React has attached it.
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

export function SessionMenu({ anchorRef, onClose }: SessionMenuProps) {
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const currentServerId = useAppSelector((ctx) => ctx.currentServerId);
  const animations = useAppSelector(selectAnimationsAllowed);
  const dispatch = useMenuDispatch();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const { ref, shown, reposition } = useFloatingSurface<typeof OPEN>({
    id: 'session-menu',
    content: OPEN,
    anchor: { kind: 'element', element: anchorRef.current },
    placement: { align: 'start' },
    animated: animations,
    onDismiss: () => closeRef.current(),
  });

  /**
   * Placed again whenever its box changes — the poll filling the list after it
   * opened — but never smaller than it has been. Opening upward, the dropdown
   * is placed by its height, so a list that shrank as you typed would pull the
   * box you are typing in down under the cursor on every key.
   */
  useEffect(() => {
    const surface = ref.current;
    if (!shown || !surface || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      surface.style.minWidth = `${surface.offsetWidth}px`;
      surface.style.minHeight = `${surface.offsetHeight}px`;
      reposition();
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [shown, ref, reposition]);

  // A press anywhere else puts it away — except on the control that opened
  // it, whose own click is the toggle (otherwise the press that closes it is
  // also the click that reopens it).
  useEffect(() => {
    if (!shown) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [shown, ref, anchorRef]);

  const choose = useCallback(
    ({ action }: SwitcherItem) => {
      const same =
        action.kind === 'event' &&
        ((action.event.type === 'SWITCH_SESSION' && action.event.sessionName === sessionName) ||
          (action.event.type === 'CONNECT_SERVER' && action.event.serverId === currentServerId));
      if (!same) dispatch(action);
      closeRef.current();
    },
    [dispatch, sessionName, currentServerId],
  );

  if (!shown) return null;

  return createPortal(
    <div
      ref={ref}
      className="floating-surface session-switcher"
      role="dialog"
      aria-label="Switch session"
      data-testid="session-switcher"
    >
      <SessionPicker onChoose={choose} onEscape={() => closeRef.current()} />
    </div>,
    surfacePortalTarget(),
  );
}
