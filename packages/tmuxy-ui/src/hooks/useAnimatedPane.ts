import { useRef, useEffect, useCallback } from 'react';

interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  precision: number;
}

interface SpringState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const DEFAULT_CONFIG: SpringConfig = {
  stiffness: 500,
  damping: 30,
  mass: 0.5,
  precision: 0.01,
};

/**
 * Hook for animating a pane's position with spring physics.
 * Manages the animation loop internally and applies transform directly to the element.
 *
 * @param targetX - Target x offset for the animation
 * @param targetY - Target y offset for the animation
 * @param elevated - Whether to elevate zIndex (for dragged panes)
 * @param enabled - Whether animations are enabled (when false, snaps immediately to target)
 * @param config - Spring physics configuration
 */
export function useAnimatedPane(
  targetX: number,
  targetY: number,
  elevated: boolean,
  enabled: boolean = true,
  config: Partial<SpringConfig> = {},
) {
  const { stiffness, damping, mass, precision } = { ...DEFAULT_CONFIG, ...config };

  const elementRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<SpringState>({ x: 0, y: 0, vx: 0, vy: 0 });
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const targetRef = useRef({ x: targetX, y: targetY });

  // Update target ref when props change
  targetRef.current = { x: targetX, y: targetY };

  const animate = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;

    const now = performance.now();
    const dt = lastTimeRef.current ? Math.min((now - lastTimeRef.current) / 1000, 0.032) : 0.016;
    lastTimeRef.current = now;

    const state = stateRef.current;
    const target = targetRef.current;

    // Spring physics
    const dx = state.x - target.x;
    const dy = state.y - target.y;

    const tensionX = -stiffness * dx;
    const tensionY = -stiffness * dy;

    const dampingX = -damping * state.vx;
    const dampingY = -damping * state.vy;

    const ax = (tensionX + dampingX) / mass;
    const ay = (tensionY + dampingY) / mass;

    state.vx += ax * dt;
    state.vy += ay * dt;

    state.x += state.vx * dt;
    state.y += state.vy * dt;

    // Apply transform
    element.style.transform = `translate3d(${state.x}px, ${state.y}px, 0)`;

    // Check if animation is complete
    const isComplete =
      Math.abs(dx) < precision &&
      Math.abs(dy) < precision &&
      Math.abs(state.vx) < precision &&
      Math.abs(state.vy) < precision;

    if (isComplete) {
      state.x = target.x;
      state.y = target.y;
      state.vx = 0;
      state.vy = 0;
      element.style.transform = `translate3d(${target.x}px, ${target.y}px, 0)`;
      frameRef.current = null;
      lastTimeRef.current = null;
    } else {
      frameRef.current = requestAnimationFrame(animate);
    }
  }, [stiffness, damping, mass, precision]);

  // Start/continue animation when target changes
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const state = stateRef.current;
    const target = targetRef.current;

    // When animations are disabled, snap immediately to target
    if (!enabled) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      state.x = target.x;
      state.y = target.y;
      state.vx = 0;
      state.vy = 0;
      lastTimeRef.current = null;
      element.style.transform = `translate3d(${target.x}px, ${target.y}px, 0)`;
      return;
    }

    // Start animation if not already running
    if (frameRef.current === null) {
      // Check if we need to animate
      const needsAnimation =
        Math.abs(state.x - target.x) > precision ||
        Math.abs(state.y - target.y) > precision ||
        Math.abs(state.vx) > precision ||
        Math.abs(state.vy) > precision;

      if (needsAnimation) {
        lastTimeRef.current = null;
        frameRef.current = requestAnimationFrame(animate);
      }
    }
  }, [targetX, targetY, enabled, animate, precision]);

  // Handle zIndex changes — only set inline when elevated (dragging)
  useEffect(() => {
    if (elementRef.current) {
      elementRef.current.style.zIndex = elevated ? 'var(--z-dragging)' : '';
    }
  }, [elevated]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      elementRef.current = el;
      if (el) {
        // Initialize transform
        el.style.transform = `translate3d(${stateRef.current.x}px, ${stateRef.current.y}px, 0)`;
        el.style.zIndex = elevated ? 'var(--z-dragging)' : '';
      }
    },
    [elevated],
  );

  return setRef;
}
