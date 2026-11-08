/**
/**
 * PhoneBottomView — under the bar below the key row (PhoneDivider), three
 * views side by side: the app menu (PhoneMenu), the tabs/panes tree, and the
 * side pane (PhoneDock). The tab bar along the top picks one, and a sideways
 * swipe slides to the view beside as a swipe between tabs does
 * (components/phone/bottomSlide.ts). The track moves on an inline transform
 * while the finger has it; React only mounts and unmounts the view riding
 * beside. While the phone's keyboard is up it is the part that gives.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { SidebarTree } from '../SidebarTree';
import { PhoneMenu } from './PhoneMenu';
import { PhoneDock } from './PhoneDock';
import { useAppSelector, useAppSend } from '../../machines/appHooks';
import { selectPhoneBottomView } from '../../machines/selectors/layout';
import type { BottomView } from '../../machines/types/domain';
import { SWIPE_EASING } from '../../machines/gestures/gestures';
import {
  BOTTOM_VIEWS,
  neighborSide,
  neighborView,
  releaseBottomSlide,
  trackOffset,
  type NeighborSide,
} from './bottomSlide';
import { decideIntent, releaseSpeed, type TouchIntent, type TouchPoint } from './touchGesture';

/** Recent samples of a slide, for the speed it is released at. */
const SPEED_SAMPLES = 4;

export const PhoneBottomView = memo(function PhoneBottomView() {
  const send = useAppSend();
  const view = useAppSelector(selectPhoneBottomView);
  const trackRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<TouchPoint | null>(null);
  const intentRef = useRef<TouchIntent>('undecided');
  const widthRef = useRef(0);
  const dxRef = useRef(0);
  const samplesRef = useRef<TouchPoint[]>([]);
  const settleTimerRef = useRef<number | null>(null);
  // The neighbour is mounted only while a slide lasts.
  const [neighbor, setNeighbor] = useState<NeighborSide | null>(null);
  const [settling, setSettling] = useState(false);

  const moveTrack = (dx: number, transition: string) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = transition;
    track.style.transform = dx === 0 ? '' : `translateX(${dx}px)`;
  };

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  // Travel that is not mostly sideways is left to the view's scroll or the
  // pane's own gestures. A finger that lands while a release is still
  // settling starts nothing: the settle is short.
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      const onTabs = (e.target as Element | null)?.closest?.('.phone-tabs');
      if (!t || e.touches.length !== 1 || settling || onTabs) {
        startRef.current = null;
        return;
      }
      const start = { x: t.clientX, y: t.clientY, t: e.timeStamp };
      startRef.current = start;
      intentRef.current = 'undecided';
      widthRef.current = e.currentTarget.getBoundingClientRect().width;
      dxRef.current = 0;
      samplesRef.current = [start];
    },
    [settling],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const start = startRef.current;
      const t = e.touches[0];
      if (!start || !t) return;
      const now = { x: t.clientX, y: t.clientY, t: e.timeStamp };
      if (intentRef.current === 'undecided') intentRef.current = decideIntent(start, now, true);
      if (intentRef.current !== 'swipe') return;
      const dx = now.x - start.x;
      dxRef.current = dx;
      const samples = samplesRef.current;
      samples.push(now);
      if (samples.length > SPEED_SAMPLES) samples.splice(0, samples.length - SPEED_SAMPLES);
      setNeighbor((side) => neighborSide(dx) ?? side);
      moveTrack(trackOffset(view, dx), 'none');
    },
    [view],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start || intentRef.current !== 'swipe') return;
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - start.x : dxRef.current;
      const { target, next, settleMs } = releaseBottomSlide(
        view,
        dx,
        releaseSpeed(samplesRef.current),
        widthRef.current,
      );
      setSettling(true);
      moveTrack(target, `transform ${settleMs}ms ${SWIPE_EASING}`);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        if (next) send({ type: 'SET_PHONE_BOTTOM_VIEW', view: next });
        moveTrack(0, 'none');
        setNeighbor(null);
        setSettling(false);
      }, settleMs);
    },
    [send, view],
  );

  const panel = (which: BottomView) => {
    switch (which) {
      case 'menu':
        return <PhoneMenu />;
      case 'tree':
        return (
          <div className="phone-tree">
            <SidebarTree focused={false} />
          </div>
        );
      case 'dock':
        return <PhoneDock />;
    }
  };
  const beside = neighbor ? neighborView(view, neighbor) : null;

  return (
    <div
      className={`phone-bottom phone-bottom-${view}`}
      data-testid="phone-bottom"
      data-view={view}
      data-sliding={neighbor ? (settling ? 'settling' : 'tracking') : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <PhoneTabs
        view={view}
        onPick={(picked) => send({ type: 'SET_PHONE_BOTTOM_VIEW', view: picked })}
      />
      <div className="phone-bottom-stage">
        <div ref={trackRef} className="phone-bottom-track">
          <div className="phone-bottom-panel">{panel(view)}</div>
          {neighbor && beside && (
            <div className={`phone-bottom-panel phone-bottom-panel-${neighbor}`} aria-hidden="true">
              {panel(beside)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

const TAB_LABELS: Record<BottomView, string> = { menu: 'Menu', tree: 'Tree', dock: 'Side pane' };

function TabIcon({ view }: { view: BottomView }) {
  return (
    <svg
      className="phone-tab-icon"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {view === 'menu' && <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />}
      {view === 'tree' && (
        <>
          <rect x="1.5" y="1.5" width="6" height="3" rx="1" />
          <path d="M4 4.5V12h3.5M4 8h3.5" />
          <rect x="8.5" y="6.5" width="6" height="3" rx="1" />
          <rect x="8.5" y="10.5" width="6" height="3" rx="1" />
        </>
      )}
      {view === 'dock' && (
        <>
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M4.5 6.5L6.5 8l-2 1.5M8.5 10h3" />
        </>
      )}
    </svg>
  );
}

/** The tab bar over the views: an icon beside a name for each, the one in front underlined. */
function PhoneTabs({ view, onPick }: { view: BottomView; onPick: (view: BottomView) => void }) {
  return (
    <div className="phone-tabs" role="tablist" aria-label="Views">
      {BOTTOM_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          className={`phone-tab${v === view ? ' is-active' : ''}`}
          aria-selected={v === view}
          data-view={v}
          onClick={() => onPick(v)}
        >
          <TabIcon view={v} />
          <span className="phone-tab-label">{TAB_LABELS[v]}</span>
        </button>
      ))}
    </div>
  );
}
