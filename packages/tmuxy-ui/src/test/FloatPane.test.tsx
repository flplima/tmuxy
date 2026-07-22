import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { ReactNode } from 'react';
import type { AppMachineEvent, FloatPaneState } from '../machines/types';

vi.mock('../machines/AppContext', () => ({
  useAppSend: vi.fn(),
  useAppSelector: vi.fn(),
  selectCharSize: vi.fn(),
  selectContainerSize: vi.fn(),
}));
vi.mock('../components/Modal', () => ({
  Modal: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../components/Terminal', () => ({
  Terminal: () => <div data-testid="terminal" />,
}));
vi.mock('../components/PaneHeader', () => ({
  PaneHeader: () => <div data-testid="pane-header" />,
}));
vi.mock('../utils/renderLog', () => ({
  LogProfiler: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../utils/mobileKeyboard', () => ({
  focusKeyboardInput: vi.fn(),
  focusMobileInput: vi.fn(),
}));

import * as AppContext from '../machines/AppContext';
import { FloatPane } from '../components/FloatPane';
import * as mobileKeyboard from '../utils/mobileKeyboard';

const mockUseAppSend = AppContext.useAppSend as Mock;
const mockUseAppSelector = AppContext.useAppSelector as Mock;
const mockSelectCharSize = AppContext.selectCharSize as Mock;
const mockSelectContainerSize = AppContext.selectContainerSize as Mock;
const mockFocusKeyboardInput = vi.mocked(mobileKeyboard.focusKeyboardInput);
const mockFocusMobileInput = vi.mocked(mobileKeyboard.focusMobileInput);
const mockSend = vi.fn<(event: AppMachineEvent) => void>();

const pane = {
  id: 9,
  tmuxId: '%9',
  windowId: '@1',
  content: { lines: [] },
  cursorX: 0,
  cursorY: 0,
  width: 80,
  height: 24,
  x: 0,
  y: 0,
  active: true,
  command: 'zsh',
  title: '',
  borderTitle: '',
  inMode: false,
  copyCursorX: 0,
  copyCursorY: 0,
  alternateOn: false,
  mouseAnyFlag: false,
  paused: false,
  historySize: 0,
  selectionPresent: false,
  selectionStartX: 0,
  selectionStartY: 0,
  cursorShape: 2,
  cursorHidden: false,
};

const context = {
  panes: [pane],
  focusedFloatPaneId: null,
};

const floatState: FloatPaneState = {
  paneId: '%9',
  width: 640,
  height: 360,
  hideHeader: true,
};

function renderFloat() {
  const rendered = render(<FloatPane floatState={floatState} />);
  const container = rendered.container.querySelector<HTMLElement>('[data-pane-id="%9"]');
  expect(container).not.toBeNull();
  if (!container) throw new Error('float pane container missing');
  return container;
}

describe('FloatPane keyboard focus', () => {
  let hiddenInput: HTMLInputElement;
  let keyboardTarget: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    hiddenInput = document.createElement('input');
    document.body.appendChild(hiddenInput);
    keyboardTarget = null;

    mockUseAppSend.mockReturnValue(mockSend);
    mockUseAppSelector.mockImplementation((selector: (value: typeof context) => unknown) => {
      if (selector === mockSelectCharSize) return { charWidth: 8, charHeight: 18 };
      if (selector === mockSelectContainerSize) return { width: 1200, height: 800 };
      return selector(context);
    });
    mockSend.mockImplementation((event) => {
      if (event.type === 'FOCUS_PANE') keyboardTarget = event.paneId;
    });
    mockFocusKeyboardInput.mockImplementation((paneId) => {
      keyboardTarget = paneId;
      hiddenInput.focus();
    });
    mockFocusMobileInput.mockImplementation((paneId) => {
      const isOpen = document.activeElement === hiddenInput;
      if (isOpen && keyboardTarget === paneId) {
        hiddenInput.blur();
        keyboardTarget = null;
      } else {
        keyboardTarget = paneId;
        hiddenInput.focus();
      }
    });
  });

  afterEach(() => {
    hiddenInput.remove();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('selects the pane before moving programmatic focus to the hidden input', () => {
    const container = renderFloat();

    container.focus();

    expect(mockSend).toHaveBeenCalledWith({ type: 'FOCUS_PANE', paneId: '%9' });
    expect(mockFocusKeyboardInput).toHaveBeenCalledWith('%9');
    expect(mockSend.mock.invocationCallOrder[0]).toBeLessThan(
      mockFocusKeyboardInput.mock.invocationCallOrder[0],
    );
  });

  it('does not repeat pane selection when focus follows a mouse press', () => {
    const container = renderFloat();

    fireEvent.pointerDown(container, { pointerType: 'mouse' });
    container.focus();
    fireEvent.click(container);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockFocusKeyboardInput).toHaveBeenCalledWith('%9');
  });

  it('prevents browser focus theft and dismisses an open keyboard on a same-pane touch', () => {
    const container = renderFloat();
    keyboardTarget = '%9';
    hiddenInput.focus();

    const defaultAllowed = fireEvent.pointerDown(container, { pointerType: 'touch' });
    fireEvent.click(container);

    expect(defaultAllowed).toBe(false);
    expect(mockFocusMobileInput).toHaveBeenCalledWith('%9');
    expect(document.activeElement).not.toBe(hiddenInput);
  });

  it('keeps an open keyboard active when touch switches from another pane', () => {
    const container = renderFloat();
    keyboardTarget = '%3';
    hiddenInput.focus();

    fireEvent.pointerDown(container, { pointerType: 'touch' });
    fireEvent.click(container);

    expect(document.activeElement).toBe(hiddenInput);
    expect(keyboardTarget).toBe('%9');
    expect(mockFocusMobileInput.mock.invocationCallOrder[0]).toBeLessThan(
      mockSend.mock.invocationCallOrder[0],
    );
  });

  it('clears pointer modality when a mouse press ends outside the float', () => {
    const container = renderFloat();
    fireEvent.pointerDown(container, { pointerType: 'mouse' });

    fireEvent.pointerUp(window, { pointerType: 'mouse' });
    act(() => vi.runOnlyPendingTimers());
    container.focus();

    expect(mockSend).toHaveBeenCalledWith({ type: 'FOCUS_PANE', paneId: '%9' });
    expect(mockFocusKeyboardInput).toHaveBeenCalledWith('%9');
  });
});
