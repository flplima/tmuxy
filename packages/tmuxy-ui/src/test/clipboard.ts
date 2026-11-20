/**
 * The browser's copy command, as jsdom lacks it: `document.execCommand('copy')`
 * fires a copy event on `window` and keeps what its listeners set on it, the
 * way a real copy reaches the clipboard. `refuse` makes it the browser that
 * runs no copy (outside a key or a click), and no event fires.
 */

import { vi } from 'vitest';

export function fakeCopyCommand() {
  const copied: string[] = [];
  let refused = false;
  const command = vi.fn((name: string) => {
    if (name !== 'copy' || refused) return false;
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    const data: Record<string, string> = {};
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: (_type: string, value: string) => void (data.text = value),
        getData: () => data.text,
      },
    });
    window.dispatchEvent(event);
    copied.push(data.text);
    return true;
  });
  const before = document.execCommand;
  document.execCommand = command;
  return {
    /** What each copy put on the clipboard, in order. */
    copied,
    command,
    refuse: () => {
      refused = true;
    },
    restore: () => {
      document.execCommand = before;
    },
  };
}

/** `navigator.clipboard` with this `writeText`, or none at all (http off localhost). */
export function fakeClipboardApi(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

/** Lets a write the clipboard API answered, and what it then said, land. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
