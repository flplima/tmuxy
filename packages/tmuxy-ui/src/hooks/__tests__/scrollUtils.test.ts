import { describe, it, expect } from 'vitest';
import { sendScrollLines } from '../scrollUtils';
import type { AppMachineEvent } from '../../machines/types';

function captureSends() {
  const events: AppMachineEvent[] = [];
  const send = (e: AppMachineEvent) => {
    events.push(e);
  };
  return { events, send };
}

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
    // Button 64 = wheel up, coords 1-based (5, 8)
    expect(cmd).toContain('\\033[<64;5;8M');
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
    expect(cmd).toContain('\\033[<65;1;1M');
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
    // All commands should be SGR wheel events, NOT send-keys
    for (const ev of events) {
      const cmd = (ev as { command: string }).command;
      expect(cmd).not.toContain('send-keys');
      expect(cmd).toContain('\\033[<64');
    }
  });
});
