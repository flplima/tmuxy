import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  focusKeyboardInput,
  getMobileInput,
  setKeyboardInputTarget,
  setupMobileKeyboard,
} from '../mobileKeyboard';

const cleanups: Array<() => void> = [];

function register(handler: (text: string, paneId: string | null) => void) {
  const cleanup = setupMobileKeyboard(handler);
  cleanups.push(cleanup);
  return cleanup;
}

function insertText(text: string) {
  const input = getMobileInput();
  expect(input).not.toBeNull();
  if (!input) return;
  input.value = text;
  input.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data: text,
      inputType: 'insertText',
    }),
  );
}

describe('mobileKeyboard handler ownership', () => {
  beforeEach(() => {
    cleanups.length = 0;
    const input = getMobileInput();
    if (input) {
      input.value = '';
      input.blur();
    }
  });

  afterEach(() => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]();
  });

  it('keeps the newest handler when an older owner cleans up', () => {
    const first = vi.fn();
    const second = vi.fn();
    const cleanupFirst = register(first);
    register(second);
    focusKeyboardInput('%9');

    cleanupFirst();
    insertText('한');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith('한', '%9');
  });

  it('stops forwarding and blurs the input when the current owner cleans up', () => {
    const handler = vi.fn();
    const cleanup = register(handler);
    focusKeyboardInput('%3');

    cleanup();
    insertText('x');

    expect(handler).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(getMobileInput());
  });

  it('does not leak a previous pane target into the next owner', () => {
    const cleanupFirst = register(vi.fn());
    setKeyboardInputTarget('%3');
    cleanupFirst();
    const second = vi.fn();
    register(second);

    insertText('n');

    expect(second).toHaveBeenCalledWith('n', null);
  });
});
