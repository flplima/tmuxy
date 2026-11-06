import { describe, it, expect } from 'vitest';
import { typesKeys } from '../GuestTmuxAdapter';

// The guest sends a list that types keys without waiting on its reply, the
// one kind tmuxy-core reports no failure of (`reports_failure`); anything
// else is awaited, so a refusal reaches the store and rolls it back.
describe('which routed lines the guest sends without awaiting', () => {
  it('a list that types keys, pinned or not, on one line or several', () => {
    expect(typesKeys("send-keys -t %1 -l -- 'a'")).toBe(true);
    expect(typesKeys('select-pane -t %1 \\; send-keys C-c')).toBe(true);
    expect(typesKeys("send-keys -t %1 -l -- 'a'\nsend-keys -t %1 Enter")).toBe(true);
  });

  it('never a pinned binding that changes the layout, nor a select', () => {
    expect(typesKeys('select-pane -t %1 \\; split-window -h')).toBe(false);
    expect(typesKeys('select-window -t @2')).toBe(false);
    expect(typesKeys('refresh-client -C 80x24')).toBe(false);
  });
});
