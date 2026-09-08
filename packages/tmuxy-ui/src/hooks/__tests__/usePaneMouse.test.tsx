import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { usePaneMouse } from '../usePaneMouse';
import type { AppMachineEvent } from '../../machines/types';
import type { ScrollbackMode } from '../../tmux/types';

interface SetupOptions {
  alternateOn?: boolean;
  mouseAnyFlag?: boolean;
  scrollbackMode?: ScrollbackMode | null;
  inMode?: boolean;
  historySize?: number;
  charHeight?: number;
}

function setup(overrides: SetupOptions = {}) {
  const events: AppMachineEvent[] = [];
  const send = (e: AppMachineEvent) => {
    events.push(e);
  };
  const contentRef = createRef<HTMLDivElement>();
  const scrollRef = createRef<HTMLDivElement>();
  (contentRef as { current: HTMLDivElement }).current = document.createElement('div');
  (scrollRef as { current: HTMLDivElement }).current = document.createElement('div');

  const { result } = renderHook(() =>
    usePaneMouse(send, {
      paneId: '%1',
      charWidth: 8,
      charHeight: overrides.charHeight ?? 18,
      mouseAnyFlag: overrides.mouseAnyFlag ?? false,
      alternateOn: overrides.alternateOn ?? false,
      inMode: overrides.inMode ?? false,
      scrollbackMode: overrides.scrollbackMode ?? null,
      paneHeight: 24,
      contentRef,
      scrollRef,
      historySize: overrides.historySize ?? 100,
    }),
  );

  return { result, events, scrollRef };
}

function wheelEvent(deltaY: number): React.WheelEvent {
  const ev = {
    deltaY,
    preventDefault: () => {},
    clientX: 0,
    clientY: 0,
  };
  return ev as unknown as React.WheelEvent;
}

describe('usePaneMouse.handleWheel', () => {
  it('does NOT enter copy mode when alternateOn is true (nvim, less without mouse)', () => {
    const { result, events } = setup({ alternateOn: true, mouseAnyFlag: false });
    result.current.handleWheel(wheelEvent(-100));
    const enterCopy = events.find((e) => e.type === 'ENTER_COPY_MODE');
    expect(enterCopy).toBeUndefined();
    // Should have sent Up arrow keys instead
    const sendKeys = events.filter(
      (e) => e.type === 'SEND_COMMAND' && (e as { command: string }).command.includes('Up'),
    );
    expect(sendKeys.length).toBeGreaterThan(0);
  });

  it('does NOT enter copy mode when mouseAnyFlag is true (nvim with mouse=a)', () => {
    const { result, events } = setup({ alternateOn: true, mouseAnyFlag: true });
    result.current.handleWheel(wheelEvent(-100));
    const enterCopy = events.find((e) => e.type === 'ENTER_COPY_MODE');
    expect(enterCopy).toBeUndefined();
    // Should have sent SGR wheel-up events: button 64, injected as raw hex
    // keys ("1b 5b 3c 36 34" = ESC [ < 6 4).
    const sgrEvents = events.filter(
      (e) =>
        e.type === 'SEND_COMMAND' &&
        /send-keys -t \S+ -H 1b 5b 3c 36 34/.test((e as { command: string }).command),
    );
    expect(sgrEvents.length).toBeGreaterThan(0);
  });

  it('does NOT enter copy mode when only mouseAnyFlag is true (apps without alt screen)', () => {
    const { result, events } = setup({ alternateOn: false, mouseAnyFlag: true });
    result.current.handleWheel(wheelEvent(-100));
    const enterCopy = events.find((e) => e.type === 'ENTER_COPY_MODE');
    expect(enterCopy).toBeUndefined();
  });

  it('does NOT enter copy mode when tmux is already in a pane mode (inMode=true)', () => {
    // Guards against race: server reports in_mode=true after our cancel command
    // but the client-side copy state was already cleared.
    const { result, events } = setup({
      alternateOn: false,
      mouseAnyFlag: false,
      scrollbackMode: null,
      inMode: true,
    });
    result.current.handleWheel(wheelEvent(-100));
    const enterCopy = events.find((e) => e.type === 'ENTER_COPY_MODE');
    expect(enterCopy).toBeUndefined();
  });

  it('opens the scroll view — not copy mode — on scroll-up in a shell with scrollback', () => {
    const { result, events } = setup({
      alternateOn: false,
      mouseAnyFlag: false,
      scrollbackMode: null,
      inMode: false,
      historySize: 100,
    });
    result.current.handleWheel(wheelEvent(-100));
    // A wheel gesture must never hand the pane a cursor and vi keys; that is
    // what `prefix [` is for.
    expect(events.find((e) => e.type === 'ENTER_COPY_MODE')).toBeUndefined();
    const enterScroll = events.find((e) => e.type === 'ENTER_SCROLL_MODE');
    expect(enterScroll).toBeDefined();
    // Quantized to whole lines, and scrolling up means a negative delta.
    expect(enterScroll).toMatchObject({ paneId: '%1', scrollLines: -5 });
  });

  it('does NOT enter copy mode on scroll-down in normal shell', () => {
    const { result, events } = setup({ alternateOn: false, mouseAnyFlag: false });
    result.current.handleWheel(wheelEvent(100));
    const enterCopy = events.find((e) => e.type === 'ENTER_COPY_MODE');
    expect(enterCopy).toBeUndefined();
  });

  it('forwards wheel delta to scroll container when client copy mode is active', () => {
    const { result, scrollRef } = setup({ scrollbackMode: 'copy' });
    scrollRef.current!.scrollTop = 0;
    result.current.handleWheel(wheelEvent(50));
    expect(scrollRef.current!.scrollTop).toBe(50);
  });

  it('accumulates sub-line wheel deltas without sending events', () => {
    const { result, events } = setup({ alternateOn: true, charHeight: 18 });
    // Each event is less than one line of charHeight
    result.current.handleWheel(wheelEvent(-5));
    result.current.handleWheel(wheelEvent(-5));
    expect(events).toEqual([]);
    // Third event pushes the accumulator past 18px, triggering one line
    result.current.handleWheel(wheelEvent(-10));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type !== 'ENTER_COPY_MODE')).toBe(true);
  });
});

describe('usePaneMouse — copy-mode selection sequencing', () => {
  function setupSeq(initialMode: ScrollbackMode | null) {
    const events: AppMachineEvent[] = [];
    const send = (e: AppMachineEvent) => events.push(e);
    const contentRef = createRef<HTMLDivElement>();
    const scrollRef = createRef<HTMLDivElement>();
    (contentRef as { current: HTMLDivElement }).current = document.createElement('div');
    (scrollRef as { current: HTMLDivElement }).current = document.createElement('div');
    const baseProps = {
      paneId: '%1',
      charWidth: 8,
      charHeight: 18,
      mouseAnyFlag: false,
      alternateOn: false,
      inMode: false,
      scrollbackMode: initialMode,
      paneHeight: 24,
      contentRef,
      scrollRef,
      historySize: 100,
    };
    const { result, rerender } = renderHook((p: typeof baseProps) => usePaneMouse(send, p), {
      initialProps: baseProps,
    });
    return { result, events, rerender, baseProps };
  }

  const clickEvent = (detail: number): React.MouseEvent =>
    ({
      target: document.createElement('div'),
      detail,
      clientX: 0,
      clientY: 0,
      preventDefault: () => {},
    }) as unknown as React.MouseEvent;

  it('leaves a double-click alone outside copy mode, so the browser selects the word', () => {
    const { result, events } = setupSeq(null);
    result.current.handleDoubleClick(clickEvent(2));
    // Nothing is sent and nothing is prevented: the native selection is the
    // whole point on the live screen and in the scroll view.
    expect(events).toEqual([]);
  });

  it('word-selects through the client only in copy mode, where the cursor is the selection', () => {
    const { result, events } = setupSeq('copy');
    result.current.handleDoubleClick(clickEvent(2));
    expect(events.some((e) => e.type === 'COPY_MODE_WORD_SELECT')).toBe(true);
  });

  it('leaves a triple-click alone outside copy mode', () => {
    const { result, events } = setupSeq(null);
    result.current.handleTripleClick(clickEvent(3));
    expect(events).toEqual([]);
  });

  it('line-selects through the client in copy mode', () => {
    const { result, events } = setupSeq('copy');
    result.current.handleTripleClick(clickEvent(3));
    expect(events.some((e) => e.type === 'COPY_MODE_LINE_SELECT')).toBe(true);
  });

  it('never opens copy mode from the mouse — that is what prefix [ is for', () => {
    const { result, events } = setupSeq(null);
    result.current.handleDoubleClick(clickEvent(2));
    result.current.handleTripleClick(clickEvent(3));
    expect(events.some((e) => e.type === 'ENTER_COPY_MODE')).toBe(false);
  });
});
