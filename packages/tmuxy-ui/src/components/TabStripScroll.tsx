/**
 * TabStripScroll — the ‹ › pair that pages an overflowing tab strip.
 *
 * With more tabs than fit, the strip scrolls sideways with its scrollbar
 * hidden, which leaves a mouse without a wheel and a trackpad-less desktop no
 * way to reach the tabs past the edge. These two buttons page it by exactly
 * one strip-width at a time, the way a pager should, and the browser clamps
 * the last page to whatever is left.
 *
 * They appear only when there is something to scroll to, and each is disabled
 * at its own end — kept in place rather than hidden, so the pair does not
 * shuffle the buttons beside it every time you reach an edge.
 *
 * The strip belongs to WindowTabs; this reads it out of the DOM rather than
 * threading a ref through the status bar, because what it needs is precisely
 * the scroll geometry the browser owns.
 */

import { useCallback, useLayoutEffect, useState } from 'react';
import { useAppSelector, selectAnimationsAllowed } from '../machines/AppContext';
import { Tooltip } from './Tooltip';

/** Below this many pixels from an end, treat it as reached. */
const EDGE_SLACK_PX = 1;

function strip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.tab-list');
}

export function TabStripScroll() {
  const animations = useAppSelector(selectAnimationsAllowed);
  const [reach, setReach] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = strip();
    if (!el) {
      setReach({ left: false, right: false });
      return;
    }
    const max = el.scrollWidth - el.clientWidth;
    setReach((prev) => {
      const next = {
        left: max > EDGE_SLACK_PX && el.scrollLeft > EDGE_SLACK_PX,
        right: max > EDGE_SLACK_PX && el.scrollLeft < max - EDGE_SLACK_PX,
      };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  useLayoutEffect(() => {
    const el = strip();
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Tabs opening, closing and being renamed all change what fits, and none
    // of them resizes the strip itself.
    const mutations = new MutationObserver(measure);
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [measure]);

  const page = (direction: -1 | 1) => {
    const el = strip();
    if (!el) return;
    el.scrollBy({
      left: direction * el.clientWidth,
      behavior: animations ? 'smooth' : 'auto',
    });
  };

  // Nothing to reach in either direction: every tab is already on screen.
  if (!reach.left && !reach.right) return null;

  return (
    <>
      <Tooltip label="Scroll tabs left">
        <button
          className="tab-scroll"
          onClick={() => page(-1)}
          disabled={!reach.left}
          aria-label="Scroll tabs left"
          data-testid="tab-scroll-left"
        >
          {''}
        </button>
      </Tooltip>
      <Tooltip label="Scroll tabs right">
        <button
          className="tab-scroll"
          onClick={() => page(1)}
          disabled={!reach.right}
          aria-label="Scroll tabs right"
          data-testid="tab-scroll-right"
        >
          {''}
        </button>
      </Tooltip>
    </>
  );
}
