import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppMachineEvent } from '../../machines/types';

vi.mock('../../utils/mobileKeyboard', () => ({
  focusMobileInput: vi.fn(),
}));
vi.mock('../../utils/haptics', () => ({
  haptics: { trigger: vi.fn() },
}));

import { focusMobileInput } from '../../utils/mobileKeyboard';
import { usePaneTouch } from '../usePaneTouch';

const mockFocusMobileInput = vi.mocked(focusMobileInput);

function touchEvent(type: 'touchstart' | 'touchend', x: number, y: number): TouchEvent {
  const touch = { clientX: x, clientY: y };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === 'touchstart' ? [touch] : [] },
    changedTouches: { value: type === 'touchend' ? [touch] : [] },
  });
  return event as TouchEvent;
}

describe('usePaneTouch tap focus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('switches the keyboard target before synchronizing pane focus', () => {
    const send = vi.fn<(event: AppMachineEvent) => void>();
    const scrollRef = createRef<HTMLDivElement>();
    scrollRef.current = document.createElement('div');
    const { result } = renderHook(() =>
      usePaneTouch({
        paneId: '%9',
        charHeight: 18,
        alternateOn: false,
        mouseAnyFlag: false,
        scrollRef,
        send,
        historySize: 0,
      }),
    );
    const start = touchEvent('touchstart', 10, 20);
    const end = touchEvent('touchend', 12, 22);

    act(() => {
      result.current.handleTouchStart(start);
      result.current.handleTouchEnd(end);
    });

    expect(end.defaultPrevented).toBe(true);
    expect(mockFocusMobileInput).toHaveBeenCalledWith('%9');
    expect(send).toHaveBeenCalledWith({ type: 'FOCUS_PANE', paneId: '%9' });
    expect(mockFocusMobileInput.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0],
    );
  });
});
