import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createRef } from 'react';
import { usePaneMouse } from '../usePaneMouse';
import type { AppMachineEvent } from '../../machines/types';

interface SetupOptions {
  alternateOn?: boolean;
  mouseAnyFlag?: boolean;
  inMode?: boolean;
  historySize?: number;
  charHeight?: number;
}

function commandsFrom(events: AppMachineEvent[]): string[] {
  return events
    .filter((e) => e.type === 'SEND_COMMAND')
    .map((e) => (e as { command: string }).command);
}

function setup(overrides: SetupOptions = {}) {
  const events: AppMachineEvent[] = [];
  const send = (e: AppMachineEvent) => {
    events.push(e);
  };
  const contentRef = createRef<HTMLDivElement>();
  const el = document.createElement('div');
  // jsdom getBoundingClientRect returns zeros; that's fine — cells resolve to (0,0).
  (contentRef as { current: HTMLDivElement }).current = el;

  const { result } = renderHook(() =>
    usePaneMouse(send, {
      paneId: '%1',
      charWidth: 8,
      charHeight: overrides.charHeight ?? 18,
      mouseAnyFlag: overrides.mouseAnyFlag ?? false,
      alternateOn: overrides.alternateOn ?? false,
      inMode: overrides.inMode ?? false,
      paneHeight: 24,
      contentRef,
      historySize: overrides.historySize ?? 100,
    }),
  );

  return { result, events };
}

function wheelEvent(deltaY: number): React.WheelEvent {
  return {
    deltaY,
    preventDefault: () => {},
    clientX: 0,
    clientY: 0,
  } as unknown as React.WheelEvent;
}

function mouseEvent(over: Partial<MouseEvent> = {}): React.MouseEvent {
  return {
    button: 0,
    shiftKey: false,
    detail: 1,
    clientX: 0,
    clientY: 0,
    preventDefault: () => {},
    target: document.createElement('div'),
    ...over,
  } as unknown as React.MouseEvent;
}

describe('usePaneMouse.handleWheel', () => {
  it('sends arrow keys (not copy-mode) when alternateOn is true', () => {
    const { result, events } = setup({ alternateOn: true, mouseAnyFlag: false });
    result.current.handleWheel(wheelEvent(-100));
    const cmds = commandsFrom(events);
    expect(cmds.some((c) => c.includes('copy-mode'))).toBe(false);
    expect(cmds.some((c) => c.includes(' Up'))).toBe(true);
  });

  it('sends SGR wheel events when mouseAnyFlag is true', () => {
    const { result, events } = setup({ alternateOn: true, mouseAnyFlag: true });
    result.current.handleWheel(wheelEvent(-100));
    const cmds = commandsFrom(events);
    expect(cmds.some((c) => c.includes('copy-mode'))).toBe(false);
    expect(cmds.some((c) => c.includes('\\033[<64'))).toBe(true);
  });

  it('enters native copy mode and scrolls up in a normal shell with scrollback', () => {
    const { result, events } = setup({ historySize: 100 });
    result.current.handleWheel(wheelEvent(-100));
    const cmds = commandsFrom(events);
    expect(cmds).toContain('copy-mode -e -t %1');
    expect(cmds.some((c) => c.includes('-X scroll-up'))).toBe(true);
  });

  it('does nothing on scroll-down in a normal shell at the bottom (not in copy mode)', () => {
    const { result, events } = setup({ historySize: 100 });
    result.current.handleWheel(wheelEvent(100));
    expect(commandsFrom(events)).toEqual([]);
  });

  it('does nothing in a normal shell with no scrollback', () => {
    const { result, events } = setup({ historySize: 0 });
    result.current.handleWheel(wheelEvent(-100));
    expect(commandsFrom(events)).toEqual([]);
  });

  it('scrolls down while already in copy mode', () => {
    const { result, events } = setup({ inMode: true, historySize: 100 });
    result.current.handleWheel(wheelEvent(100));
    const cmds = commandsFrom(events);
    expect(cmds.some((c) => c.includes('-X scroll-down'))).toBe(true);
  });

  it('accumulates sub-line wheel deltas without emitting commands', () => {
    const { result, events } = setup({ alternateOn: true, charHeight: 18 });
    result.current.handleWheel(wheelEvent(-5));
    result.current.handleWheel(wheelEvent(-5));
    expect(events).toEqual([]);
    result.current.handleWheel(wheelEvent(-10));
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('usePaneMouse selection', () => {
  it('drives native copy-mode selection on drag and copies on release', () => {
    const { result, events } = setup();
    act(() => result.current.handleMouseDown(mouseEvent({ clientX: 0, clientY: 0 })));
    // Move far enough to register at least one cell of movement.
    act(() => result.current.handleMouseMove(mouseEvent({ clientX: 40, clientY: 36 })));
    const cmds = commandsFrom(events);
    expect(cmds).toContain('copy-mode -t %1');
    expect(cmds.some((c) => c.includes('-X begin-selection'))).toBe(true);

    act(() => result.current.handleMouseUp(mouseEvent({ clientX: 40, clientY: 36 })));
    expect(commandsFrom(events).some((c) => c.includes('-X copy-selection-and-cancel'))).toBe(true);
  });

  it('selects a word on double-click', () => {
    const { result, events } = setup();
    act(() => result.current.handleDoubleClick(mouseEvent({ detail: 2 })));
    const cmds = commandsFrom(events);
    expect(cmds).toContain('copy-mode -t %1');
    expect(cmds.some((c) => c.includes('-X next-word-end'))).toBe(true);
  });

  it('forwards SGR mouse press to the app when mouseAnyFlag is set', () => {
    const { result, events } = setup({ mouseAnyFlag: true });
    act(() => result.current.handleMouseDown(mouseEvent()));
    expect(commandsFrom(events).some((c) => c.includes('\\033[<0'))).toBe(true);
  });
});
