import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { usePaneMouse } from '../usePaneMouse';
import type { AppMachineEvent } from '../../machines/types';

interface SetupOptions {
  alternateOn?: boolean;
  mouseAnyFlag?: boolean;
  copyModeActive?: boolean;
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
      copyModeActive: overrides.copyModeActive ?? false,
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
    // Should have sent SGR mouse wheel events
    const sgrEvents = events.filter(
      (e) => e.type === 'SEND_COMMAND' && (e as { command: string }).command.includes('\\033[<64'),
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
      copyModeActive: false,
      inMode: true,
    });
    result.current.handleWheel(wheelEvent(-100));
    const enterCopy = events.find((e) => e.type === 'ENTER_COPY_MODE');
    expect(enterCopy).toBeUndefined();
  });

  it('enters copy mode on scroll-up in a normal shell with scrollback', () => {
    const { result, events } = setup({
      alternateOn: false,
      mouseAnyFlag: false,
      copyModeActive: false,
      inMode: false,
      historySize: 100,
    });
    result.current.handleWheel(wheelEvent(-100));
    const enterCopy = events.find((e) => e.type === 'ENTER_COPY_MODE');
    expect(enterCopy).toBeDefined();
  });

  it('does NOT enter copy mode on scroll-down in normal shell', () => {
    const { result, events } = setup({ alternateOn: false, mouseAnyFlag: false });
    result.current.handleWheel(wheelEvent(100));
    const enterCopy = events.find((e) => e.type === 'ENTER_COPY_MODE');
    expect(enterCopy).toBeUndefined();
  });

  it('forwards wheel delta to scroll container when client copy mode is active', () => {
    const { result, scrollRef } = setup({ copyModeActive: true });
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
