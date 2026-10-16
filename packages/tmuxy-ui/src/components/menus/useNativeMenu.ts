/**
 * A context menu's host: on the desktop the spec is shown as a native popup
 * at the point (and the surface draws nothing); elsewhere, or when the popup
 * is refused, the surface draws its floating menu. One hook, so every
 * context menu takes the same decision the same way.
 */

import { useEffect, useRef, useState } from 'react';
import type { MenuSpec } from '../../domain/menus/spec';
import { popupNativeMenu } from '../../infra/menus/nativeMenu';
import type { MenuDispatch } from './SpecMenu';
import { useMenuHost } from './menuHost';

export interface NativeMenuPoint {
  x: number;
  y: number;
}

/**
 * `true` when the surface should draw the in-app menu. The spec and dispatch
 * are read once, when the popup opens: a native menu is a snapshot, not a
 * live view, and the gesture is over by the time it closes.
 */
export function useNativeMenu(
  spec: MenuSpec,
  dispatch: MenuDispatch,
  at: NativeMenuPoint,
  onClose: () => void,
): boolean {
  const host = useMenuHost();
  const native = host !== 'in-app';
  const [fallback, setFallback] = useState(false);
  const latest = useRef({ spec, dispatch, at, onClose });
  latest.current = { spec, dispatch, at, onClose };

  useEffect(() => {
    if (!native) return;
    const { spec, dispatch, at, onClose } = latest.current;
    // The popup swallows the pointer-up the press was waiting for: release
    // whatever the page is holding (a pane's drag, a strip press) first.
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    let cancelled = false;
    popupNativeMenu(spec, dispatch, at).then(
      () => {
        if (!cancelled) onClose();
      },
      () => {
        if (!cancelled) setFallback(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [native]);

  return !native || fallback;
}

/** The point a menu anchored to an element opens at: under its left edge. */
export function belowElement(element: HTMLElement | null): NativeMenuPoint {
  if (!element) return { x: 0, y: 0 };
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 2 };
}
