import { describe, it, expect } from 'vitest';
import { sendScrollLines, sgrMouseCommand, takeWholeRows, scrollByRows } from '../scrollUtils';
import type { AppMachineEvent } from '../../machines/types';

function captureSends() {
  const events: AppMachineEvent[] = [];
  const send = (e: AppMachineEvent) => {
    events.push(e);
  };
  return { events, send };
}

describe('takeWholeRows', () => {
  it('takes the whole rows and carries the rest', () => {
    expect(takeWholeRows(50, 18, 0)).toEqual({ rows: 2, remainder: 14 });
  });

  it('adds the carried remainder to the next delta', () => {
    expect(takeWholeRows(4, 18, 14)).toEqual({ rows: 1, remainder: 0 });
  });

  it('takes nothing from a delta smaller than a row', () => {
    expect(takeWholeRows(6, 18, 0)).toEqual({ rows: 0, remainder: 6 });
  });

  it('truncates towards zero in both directions', () => {
    expect(takeWholeRows(-50, 18, 0)).toEqual({ rows: -2, remainder: -14 });
  });

  it('takes nothing when the row height is unknown', () => {
    expect(takeWholeRows(50, 0, 0)).toEqual({ rows: 0, remainder: 0 });
  });
});

describe('scrollByRows', () => {
  const container = (scrollTop: number) => {
    const el = document.createElement('div');
    el.scrollTop = scrollTop;
    return el;
  };

  it('moves by whole rows and lands on a row boundary', () => {
    const el = container(36);
    scrollByRows(el, 2, 18);
    expect(el.scrollTop).toBe(72);
    scrollByRows(el, -1, 18);
    expect(el.scrollTop).toBe(54);
  });

  it('pulls a container left mid-row back onto the grid', () => {
    // Something else moved it — a scrollIntoView, a font-size change. The
    // next scroll snaps rather than carrying the offset for good.
    const el = container(40);
    scrollByRows(el, 1, 18);
    expect(el.scrollTop).toBe(54);
  });

  it('stops at the top', () => {
    const el = container(18);
    scrollByRows(el, -5, 18);
    expect(el.scrollTop).toBe(0);
  });

  it('does nothing without rows or a row height', () => {
    const el = container(36);
    scrollByRows(el, 0, 18);
    scrollByRows(el, 3, 0);
    expect(el.scrollTop).toBe(36);
  });
});

describe('sendScrollLines', () => {
  it('returns false in normal shell mode (lets caller handle copy-mode proxy)', () => {
    const { events, send } = captureSends();
    const handled = sendScrollLines({
      send,
      paneId: '%1',
      lines: -3,
      alternateOn: false,
      mouseAnyFlag: false,
    });
    expect(handled).toBe(false);
    expect(events).toEqual([]);
  });

  it('returns true with no events when lines=0', () => {
    const { events, send } = captureSends();
    const handled = sendScrollLines({
      send,
      paneId: '%1',
      lines: 0,
      alternateOn: true,
      mouseAnyFlag: false,
    });
    expect(handled).toBe(true);
    expect(events).toEqual([]);
  });

  it('sends Up arrows for scroll-up in alternate-screen apps without mouse tracking', () => {
    const { events, send } = captureSends();
    sendScrollLines({
      send,
      paneId: '%1',
      lines: -3,
      alternateOn: true,
      mouseAnyFlag: false,
    });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type === 'SEND_COMMAND')).toBe(true);
    expect(events.map((e) => (e as { command: string }).command)).toEqual([
      'send-keys -t %1 Up',
      'send-keys -t %1 Up',
      'send-keys -t %1 Up',
    ]);
  });

  it('sends Down arrows for scroll-down in alternate-screen apps without mouse tracking', () => {
    const { events, send } = captureSends();
    sendScrollLines({
      send,
      paneId: '%1',
      lines: 2,
      alternateOn: true,
      mouseAnyFlag: false,
    });
    expect(events.map((e) => (e as { command: string }).command)).toEqual([
      'send-keys -t %1 Down',
      'send-keys -t %1 Down',
    ]);
  });

  it('sends SGR wheel-up events when mouse tracking is enabled', () => {
    const { events, send } = captureSends();
    sendScrollLines({
      send,
      paneId: '%1',
      lines: -1,
      alternateOn: false,
      mouseAnyFlag: true,
      cellX: 4,
      cellY: 7,
    });
    expect(events).toHaveLength(1);
    const cmd = (events[0] as { command: string }).command;
    // Button 64 = wheel up, coords 1-based (5, 8), injected as raw hex keys
    expect(cmd).toBe(sgrMouseCommand('%1', 64, 5, 8));
  });

  it('sends SGR wheel-down events when mouse tracking is enabled', () => {
    const { events, send } = captureSends();
    sendScrollLines({
      send,
      paneId: '%1',
      lines: 1,
      alternateOn: false,
      mouseAnyFlag: true,
      cellX: 0,
      cellY: 0,
    });
    expect(events).toHaveLength(1);
    const cmd = (events[0] as { command: string }).command;
    // Button 65 = wheel down, coords 1-based (1, 1)
    expect(cmd).toBe(sgrMouseCommand('%1', 65, 1, 1));
  });

  it('prefers SGR mouse events when BOTH alternate-screen and mouse tracking are active', () => {
    // Neovim with `mouse=a` enables alternate screen AND mouse tracking.
    // It expects raw mouse wheel events, not Up/Down arrows (those would
    // move the cursor instead of scrolling the viewport).
    const { events, send } = captureSends();
    sendScrollLines({
      send,
      paneId: '%1',
      lines: -2,
      alternateOn: true,
      mouseAnyFlag: true,
      cellX: 0,
      cellY: 0,
    });
    expect(events).toHaveLength(2);
    // All commands should be SGR wheel events, NOT synthetic arrow keys
    for (const ev of events) {
      const cmd = (ev as { command: string }).command;
      expect(cmd).not.toMatch(/send-keys -t \S+ (Up|Down)/);
      expect(cmd).toBe(sgrMouseCommand('%1', 64, 1, 1));
    }
  });
});
